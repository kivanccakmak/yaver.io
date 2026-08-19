package main

// browser_interactive.go — generic interactive / human-in-the-loop co-browse.
//
// Streams a headful browser as JPEG frames and relays mouse/keyboard/scroll
// input so a human can solve a captcha or log in remotely. Once the human is
// done, automation resumes against the same persistent session (cookies and
// auth state survive on disk in the per-session profile directory).
//
// This is GENERIC — it has no knowledge of any particular site. It just opens
// a browser, navigates to a URL, and exposes raw input/frame primitives.

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/chromedp/cdproto/input"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/chromedp"
)

// findChromePath discovers a usable Chrome/Chromium executable.
//
// System Chrome may be absent on a dev/CI machine, but a Playwright-managed
// Chromium is often present. We check, in order:
//  1. chromedp's own auto-discovery (return "" to let chromedp find it).
//  2. Playwright cache globs (Linux and macOS).
//  3. exec.LookPath for common binary names.
//
// Returns "" when nothing better than chromedp's default is found, in which
// case the caller should NOT set an explicit ExecPath.
func findChromePath() string {
	// (a) A Playwright-managed Chromium, which chromedp does not know about.
	if p := playwrightChromePath(); p != "" {
		return p
	}

	// (b) Common binary names on PATH.
	//
	// EXISTENCE ONLY — this function answers "is there a browser at all", which
	// is why doctor_browser_lane.go can use it as a cheap gate. It is NOT the
	// right answer to "which browser should we launch": on Ubuntu both
	// `chromium` and `chromium-browser` resolve to a confined snap that exits 1
	// on every invocation. That question is resolveLaunchableChrome's
	// (browser_resolve.go), which RUNS each candidate.
	for _, name := range []string{
		"google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
	} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}

	// Fall back to chromedp's default discovery.
	return ""
}

// playwrightChromePath returns a Chromium from the Playwright browser cache,
// or "" when none is installed.
//
// Split out of findChromePath so the launch-probing resolver in
// browser_resolve.go can consider it as one more CANDIDATE — subject to the
// same `--version` test as everything else — rather than as a trusted answer.
// An unlaunchable Playwright build must lose to a working system Chrome.
func playwrightChromePath() string {
	home, _ := os.UserHomeDir()
	if home == "" {
		return ""
	}
	var globs []string
	switch runtime.GOOS {
	case "darwin":
		globs = []string{
			filepath.Join(home, "Library/Caches/ms-playwright/chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium"),
			filepath.Join(home, "Library/Caches/ms-playwright/chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
		}
	default: // linux and others
		globs = []string{
			filepath.Join(home, ".cache/ms-playwright/chromium-*/chrome-linux/chrome"),
		}
	}
	for _, g := range globs {
		matches, _ := filepath.Glob(g)
		for _, m := range matches {
			if fi, err := os.Stat(m); err == nil && !fi.IsDir() {
				return m
			}
		}
	}
	return ""
}

// nativeKeychainBrowserProfile reports whether profileDir is an existing
// system Chrome/Chromium profile whose cookies are encrypted with the macOS
// login keychain. chromedp's defaults force --password-store=basic and
// --use-mock-keychain; that makes a profile visibly signed in when opened by
// the user but signed out when Yaver opens the exact same bytes. This happened
// during an App Store Connect deploy on 2026-08-18.
//
// Only explicit profiles under the native browser roots get this exception.
// Yaver's own ~/.yaver/browser-profiles remain isolated on the mock keychain.
func nativeKeychainBrowserProfile(profileDir, home, goos string) bool {
	if goos != "darwin" || profileDir == "" || home == "" {
		return false
	}
	profileDir = filepath.Clean(profileDir)
	roots := []string{
		filepath.Join(home, "Library", "Application Support", "Chromium"),
		filepath.Join(home, "Library", "Application Support", "Google", "Chrome"),
	}
	for _, root := range roots {
		rel, err := filepath.Rel(root, profileDir)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// nativeBrowserExecutableForProfile keeps the profile bytes paired with the
// browser that encrypted them. Google Chrome and Chromium use different macOS
// Safe Storage keys; launching a Chrome profile in Chromium produces a cleanly
// running browser that is silently signed out everywhere.
func nativeBrowserExecutableForProfile(profileDir, home, goos string) string {
	if goos != "darwin" || profileDir == "" || home == "" {
		return ""
	}
	profileDir = filepath.Clean(profileDir)
	browsers := []struct {
		root string
		exec string
	}{
		{
			root: filepath.Join(home, "Library", "Application Support", "Google", "Chrome"),
			exec: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		},
		{
			root: filepath.Join(home, "Library", "Application Support", "Chromium"),
			exec: "/Applications/Chromium.app/Contents/MacOS/Chromium",
		},
	}
	for _, browser := range browsers {
		rel, err := filepath.Rel(browser.root, profileDir)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return browser.exec
		}
	}
	return ""
}

// defaultNativeBrowserDataDir reports whether profileDir is the browser's
// actual default user-data-dir. Chromium 136+ deliberately ignores remote
// debugging switches for that directory, so attempting to automate it waits
// for the DevTools endpoint until Yaver's boot timeout expires. A dedicated
// persistent Yaver profile remains visible, reusable, and keychain-backed
// without weakening Chromium's protection of the user's daily profile.
func defaultNativeBrowserDataDir(profileDir, home, goos string) bool {
	if goos != "darwin" || profileDir == "" || home == "" {
		return false
	}
	profileDir = filepath.Clean(profileDir)
	return profileDir == filepath.Join(home, "Library", "Application Support", "Chromium") ||
		profileDir == filepath.Join(home, "Library", "Application Support", "Google", "Chrome")
}

// OpenInteractiveSession starts a headful Chrome wired for human-in-the-loop
// co-browse. Like OpenSession but with a persistent profile dir, a real window
// size, automation-detection mitigations, and an explicit ExecPath when a
// browser can be discovered.
func (bm *BrowserManager) OpenInteractiveSession(id, profileDir string, width, height int) error {
	headful := os.Getenv("YAVER_BROWSER_HEADED") == "1"
	return bm.openInteractiveSession(id, profileDir, width, height, headful)
}

// OpenInteractiveSessionMode is the explicit caller-facing variant. Browser
// tools must pass the requested visibility here; the environment-backed
// wrapper above remains for older internal callers.
func (bm *BrowserManager) OpenInteractiveSessionMode(id, profileDir string, width, height int, headful bool) error {
	return bm.openInteractiveSession(id, profileDir, width, height, headful)
}

func (bm *BrowserManager) openInteractiveSession(id, profileDir string, width, height int, headful bool) error {
	bm.mu.Lock()
	defer bm.mu.Unlock()

	if _, exists := bm.sessions[id]; exists {
		return fmt.Errorf("browser session %q already exists", id)
	}

	if width <= 0 {
		width = 1280
	}
	if height <= 0 {
		height = 800
	}
	if home, err := os.UserHomeDir(); err == nil && defaultNativeBrowserDataDir(profileDir, home, runtime.GOOS) {
		return fmt.Errorf("Chromium protects its default profile from remote debugging; use a dedicated persistent profile and complete login once in the visible co-browse window")
	}

	// ── Headless when there is no GUI session to draw into ──────────────────
	//
	// headless=false launches a WINDOWED Chrome. The agent normally runs under
	// launchd (macOS) or systemd (Linux) with no user session attached, so that
	// window has nowhere to appear: Chrome starts, never finishes bringing up
	// its UI, and the DevTools dial times out. Measured on the Mac mini
	// 2026-07-26 with Chrome installed and running:
	//
	//   launch interactive chrome: could not dial ws://127.0.0.1:.../devtools/
	//   browser/...: context deadline exceeded
	//
	// which reads as "no Chrome" and sent me looking for a missing binary.
	//
	// For the remote-browser case a window is not wanted anyway: frames are
	// captured through CDP (Page.captureScreenshot) and streamed to whichever
	// device the user is holding, so nothing needs to be drawn on the host. The
	// new headless mode is a real Chrome — same engine, same rendering — not the
	// old stripped one.
	//
	// A caller that genuinely wants a visible window on a machine someone is
	// sitting at can still ask for it; the default now matches where the agent
	// actually lives.
	headlessMode := "new"
	if headful {
		headlessMode = "false"
	}
	allocOpts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("headless", headlessMode),
		chromedp.Flag("mute-audio", true),
		chromedp.Flag("no-sandbox", true),
		// Not evasion: a HUMAN drives this session from another device, so the
		// automation hint would be factually wrong. Nothing here defeats a
		// CAPTCHA — a challenge simply appears on the user's screen and they
		// solve it, exactly as they would sitting at the machine.
		chromedp.Flag("disable-blink-features", "AutomationControlled"),
		chromedp.WindowSize(width, height),
	)
	if home, err := os.UserHomeDir(); err == nil && nativeKeychainBrowserProfile(profileDir, home, runtime.GOOS) {
		// Boolean false overwrites chromedp's default flag map entry and omits
		// the switch entirely, allowing Chromium to use the real macOS keychain.
		allocOpts = append(allocOpts,
			chromedp.Flag("password-store", false),
			chromedp.Flag("use-mock-keychain", false),
		)
	}
	if profileDir != "" {
		allocOpts = append(allocOpts, chromedp.UserDataDir(profileDir))
	}
	chromePath := ""
	if home, err := os.UserHomeDir(); err == nil {
		chromePath = nativeBrowserExecutableForProfile(profileDir, home, runtime.GOOS)
	}
	if chromePath != "" {
		if info, err := os.Stat(chromePath); err != nil || info.IsDir() {
			return fmt.Errorf("browser profile requires %s, but that executable is unavailable; install or reinstall the matching browser", chromePath)
		}
	} else {
		chromePath = findChromePath()
	}
	if chromePath != "" {
		allocOpts = append(allocOpts, chromedp.ExecPath(chromePath))
	}

	allocCtx, allocCancel := newPinnedChromeAllocator(context.Background(), allocOpts...)
	browserCtx, browserCancel := chromedp.NewContext(allocCtx)

	// Boot Chrome. A cold first launch with a fresh profile can take a while —
	// far longer than chromedp's default patience — so give it an explicit,
	// generous budget rather than reporting a slow start as a missing browser.
	// Do not wrap browserCtx in a child timeout context here: chromedp binds the
	// browser target to the context passed to Run, so cancelling that child after
	// a successful boot tears down the session immediately. Use a timer that only
	// cancels the real browser context when boot overruns the budget.
	bootTimer := time.AfterFunc(60*time.Second, browserCancel)
	if err := chromedp.Run(browserCtx); err != nil {
		bootTimer.Stop()
		browserCancel()
		allocCancel()
		return fmt.Errorf("launch interactive chrome: %w (install Chrome/Chromium or Playwright Chromium)", err)
	}
	bootTimer.Stop()

	now := time.Now()
	bm.sessions[id] = &BrowserSession{
		ID:            id,
		Headful:       headful,
		Interactive:   true,
		ProfileDir:    profileDir,
		ViewW:         width,
		ViewH:         height,
		CreatedAt:     now,
		LastUsedAt:    now,
		allocCancel:   allocCancel,
		browserCtx:    browserCtx,
		browserCancel: browserCancel,
	}

	bm.emit(BrowserEvent{
		Type:      "action",
		SessionID: id,
		Message:   "interactive session opened",
	})

	return nil
}

// FrameJPEG captures the current page as a JPEG (for low-latency streaming).
func (bm *BrowserManager) FrameJPEG(id string, quality int) ([]byte, error) {
	s, err := bm.getSession(id)
	if err != nil {
		return nil, err
	}
	bm.touch(s)

	if quality <= 0 || quality > 100 {
		quality = 55
	}

	var buf []byte
	if err := chromedp.Run(s.browserCtx, chromedp.ActionFunc(func(ctx context.Context) error {
		b, e := page.CaptureScreenshot().
			WithFormat(page.CaptureScreenshotFormatJpeg).
			WithQuality(int64(quality)).
			Do(ctx)
		if e != nil {
			return e
		}
		buf = b
		return nil
	})); err != nil {
		return nil, fmt.Errorf("frame jpeg: %w", err)
	}
	return buf, nil
}

// InjectClick dispatches a real mouse click at viewport coordinates.
func (bm *BrowserManager) InjectClick(id string, x, y float64) error {
	s, err := bm.getSession(id)
	if err != nil {
		return err
	}
	bm.touch(s)
	if err := chromedp.Run(s.browserCtx, chromedp.MouseClickXY(x, y)); err != nil {
		return fmt.Errorf("inject click: %w", err)
	}
	return nil
}

// InjectKeys dispatches keyboard input (raw text or key sequences).
func (bm *BrowserManager) InjectKeys(id, text string) error {
	s, err := bm.getSession(id)
	if err != nil {
		return err
	}
	bm.touch(s)
	if err := chromedp.Run(s.browserCtx, chromedp.KeyEvent(text)); err != nil {
		return fmt.Errorf("inject keys: %w", err)
	}
	return nil
}

// InjectScroll dispatches a mouse-wheel scroll at viewport coordinates.
func (bm *BrowserManager) InjectScroll(id string, x, y, dy float64) error {
	s, err := bm.getSession(id)
	if err != nil {
		return err
	}
	bm.touch(s)
	if err := chromedp.Run(s.browserCtx, chromedp.ActionFunc(func(ctx context.Context) error {
		return input.DispatchMouseEvent(input.MouseWheel, x, y).
			WithDeltaX(0).
			WithDeltaY(dy).
			Do(ctx)
	})); err != nil {
		return fmt.Errorf("inject scroll: %w", err)
	}
	return nil
}

// Prefill optionally fills a form field before handing control to the human
// (e.g. pre-populate a username so they only have to solve the captcha).
func (bm *BrowserManager) Prefill(id, selector, value string) error {
	s, err := bm.getSession(id)
	if err != nil {
		return err
	}
	bm.touch(s)
	if err := chromedp.Run(s.browserCtx,
		chromedp.WaitVisible(selector, chromedp.ByQuery),
		chromedp.SendKeys(selector, value, chromedp.ByQuery),
		chromedp.Sleep(150*time.Millisecond),
	); err != nil {
		return fmt.Errorf("prefill %q: %w", selector, err)
	}
	return nil
}

// InteractiveStatus returns the current URL and title for a session.
func (bm *BrowserManager) InteractiveStatus(id string) (url, title string, err error) {
	s, e := bm.getSession(id)
	if e != nil {
		return "", "", e
	}
	bm.touch(s)
	if e := chromedp.Run(s.browserCtx,
		chromedp.Location(&url),
		chromedp.Title(&title),
	); e != nil {
		return "", "", fmt.Errorf("interactive status: %w", e)
	}
	bm.mu.Lock()
	s.CurrentURL = url
	s.CurrentTitle = title
	bm.mu.Unlock()
	return url, title, nil
}
