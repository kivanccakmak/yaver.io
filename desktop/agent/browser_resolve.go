package main

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// browser_resolve.go — WHICH Chrome, decided by launching one.
//
// ─── The incident, measured ────────────────────────────────────────────────
//
// On the owner's ubuntu-4gb box, 2026-08-03, every /vibing/preview/start
// returned 400 with:
//
//	cannot create temporary directory for the root file system
//
// and the tvOS/visionOS colour arcs — which sample that capture pipeline — had
// nothing to look at. A snap-packaged Chromium is CONFINED: launched from a
// daemon it cannot create its temp dir, and no retry or reinstall changes it.
//
// The first fix (bcb49b8d3, shipped as 1.99.399) deprioritised any path
// containing "/snap/". Then this ran on the box:
//
//	chromium             /snap/bin/chromium             exit=1  cannot create temporary directory…
//	chromium-browser     /usr/bin/chromium-browser      exit=1  cannot create temporary directory…
//	google-chrome        /usr/bin/google-chrome         exit=0  Google Chrome 150.0.7871.186
//	google-chrome-stable /usr/bin/google-chrome-stable  exit=0  Google Chrome 150.0.7871.186
//
// `/usr/bin/chromium-browser` is a 2,408-byte shell script from 2020 —
// Ubuntu's transitional SNAP REDIRECTOR. Its path contains no "/snap/", so the
// string test ranks it as unconfined and would pick it on any box without
// google-chrome, failing in exactly the way the fix was written to prevent.
// The heuristic was a proxy for the thing that matters, and proxies drift.
//
// ─── So: probe the operation ───────────────────────────────────────────────
//
// `--version` is the cheapest execution that proves a binary actually runs,
// and it is the exact operation that distinguishes every case above. No path
// string, no package format, no distro special-case: run it, believe the exit
// code. A future confinement scheme nobody has invented yet fails this test on
// the day it ships.
//
// This also merges two orderings that had already drifted apart:
//
//	browser.go              google-chrome first, snap last   (the capture path)
//	preview_capability_probe.go  chromium first, and RETURNS on the first
//	                             failure — so a box whose snap chromium is
//	                             broken reported "no browser" while a working
//	                             /usr/bin/google-chrome sat right there, and
//	                             the remedy told the user to install a deb they
//	                             did not need
//
// One resolver, one order, one truth. Both call sites now share it.

// chromeAttempt records one candidate and what happened when it was RUN.
//
// Kept even on success so a failure message can say what was tried and why
// each was rejected — "no browser found" sends a user hunting; "3 tried:
// /snap/bin/chromium cannot create its temp dir (confined snap)" does not.
type chromeAttempt struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

// chromeCandidateNames is the search order, best-first.
//
// google-chrome leads because a Google-packaged deb/rpm is never confined.
// The chromium names trail because on Debian/Ubuntu they are the ones that may
// be snap redirectors — but they are still tried, and still WIN if they launch,
// because a working chromium is a working browser.
var chromeCandidateNames = []string{
	"google-chrome", "google-chrome-stable",
	"chromium", "chromium-browser",
	"chrome",
}

// chromeProbeTimeout bounds one `--version`.
//
// A confined snap fails in milliseconds, but a cold snap mount can take
// seconds, and this runs behind a preview start that a user is waiting on.
const chromeProbeTimeout = 6 * time.Second

type chromeResolution struct {
	path     string
	attempts []chromeAttempt
	at       time.Time
}

var (
	chromeResolveMu    sync.Mutex
	chromeResolveCache *chromeResolution
)

// chromeResolveTTL is how long a resolution is reused.
//
// The capture loop runs at 1-2 fps and asks for a path every frame; shelling
// out `--version` that often would be its own defect. Fifteen minutes is long
// enough to be free and short enough that installing a browser is noticed
// without restarting the agent.
const chromeResolveTTL = 15 * time.Minute

// resolveLaunchableChrome returns the first candidate that ACTUALLY LAUNCHES,
// plus the full record of what was tried.
//
// When nothing launches it returns the first binary that at least EXISTS, so
// behaviour is never worse than before this file: a browser that might work in
// a user session beats refusing to try. The attempts make that fallback
// visible instead of silent.
func resolveLaunchableChrome(ctx context.Context) (string, []chromeAttempt) {
	chromeResolveMu.Lock()
	if c := chromeResolveCache; c != nil && time.Since(c.at) < chromeResolveTTL {
		path, attempts := c.path, c.attempts
		chromeResolveMu.Unlock()
		return path, attempts
	}
	chromeResolveMu.Unlock()

	path, attempts := probeChromeCandidates(ctx)

	chromeResolveMu.Lock()
	chromeResolveCache = &chromeResolution{path: path, attempts: attempts, at: time.Now()}
	chromeResolveMu.Unlock()
	return path, attempts
}

// invalidateChromeResolution drops the cache so the next resolve re-probes.
// Called when a launch fails despite the cached path having probed OK — the
// binary changed under us, or the failure is environmental.
func invalidateChromeResolution() {
	chromeResolveMu.Lock()
	chromeResolveCache = nil
	chromeResolveMu.Unlock()
}

func probeChromeCandidates(ctx context.Context) (string, []chromeAttempt) {
	if ctx == nil {
		ctx = context.Background()
	}
	var attempts []chromeAttempt
	firstFound := ""

	try := func(name, path string) bool {
		if firstFound == "" {
			firstFound = path
		}
		cctx, cancel := context.WithTimeout(ctx, chromeProbeTimeout)
		out, err := exec.CommandContext(cctx, path, "--version").CombinedOutput()
		cancel()
		detail := strings.TrimSpace(string(out))
		if err != nil {
			attempts = append(attempts, chromeAttempt{
				Name: name, Path: path, OK: false,
				Detail: describeChromeLaunchFailure(path, detail, err),
			})
			return false
		}
		attempts = append(attempts, chromeAttempt{Name: name, Path: path, OK: true, Detail: detail})
		return true
	}

	for _, name := range chromeCandidateNames {
		path, err := exec.LookPath(name)
		if err != nil || path == "" {
			continue
		}
		if try(name, path) {
			return path, attempts
		}
	}

	// A Playwright-managed Chromium is not on PATH and chromedp does not know
	// its cache layout, so it is checked last but PROBED the same way — an
	// unlaunchable Playwright build must not win either.
	if p := playwrightChromePath(); p != "" {
		if try("playwright-chromium", p) {
			return p, attempts
		}
	}

	return firstFound, attempts
}

// describeChromeLaunchFailure turns an exec error into a sentence that names
// the remedy, per the "carry the why into the error text" rule.
func describeChromeLaunchFailure(path, out string, err error) string {
	low := strings.ToLower(out)
	switch {
	case strings.Contains(low, "cannot create temporary directory"),
		strings.Contains(low, "cannot create user data directory"):
		return fmt.Sprintf("%s is a CONFINED snap — it cannot create its temp dir when launched from a daemon, "+
			"and no reinstall changes that. Install an unconfined build: "+
			"`apt-get install -y google-chrome-stable` (or the chromium .deb). Observed: %s", path, out)
	case strings.Contains(low, "permission denied"):
		return fmt.Sprintf("%s is not executable by this user (%v)", path, err)
	case out != "":
		return fmt.Sprintf("%s failed to launch (%v): %s", path, err, out)
	default:
		return fmt.Sprintf("%s failed to launch (%v)", path, err)
	}
}

// chromeAttemptsSummary renders the attempts for an error message or a UI.
func chromeAttemptsSummary(attempts []chromeAttempt) string {
	if len(attempts) == 0 {
		return "no Chrome/Chromium binary found on PATH"
	}
	parts := make([]string, 0, len(attempts))
	for _, a := range attempts {
		if a.OK {
			parts = append(parts, fmt.Sprintf("%s OK (%s)", a.Path, a.Detail))
			continue
		}
		parts = append(parts, a.Detail)
	}
	return strings.Join(parts, "; ")
}
