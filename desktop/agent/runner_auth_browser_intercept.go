package main

// runner_auth_browser_intercept.go — capture the URL a runner CLI opens.
//
// ── The problem this solves ─────────────────────────────────────────────────
//
// Remote sign-in needs the OAuth URL. Measured 2026-07-26 against real CLIs:
//
//   claude auth login --claudeai   silent in a pipe, under `script`, in a real
//                                  tmux TTY, with BROWSER=echo, and inside the
//                                  agent's own launchd session. It opens a
//                                  browser locally and prints nothing, ever.
//   codex login --device-auth      accepted (it hangs rather than erroring, so
//                                  the flag exists) but emits nothing either.
//   kimi login                     prints URL + code properly — the exception,
//                                  not the rule.
//
// So scraping stdout cannot be the strategy. Two of the three CLIs a user is
// most likely to have will never print anything to scrape.
//
// ── What this does instead ──────────────────────────────────────────────────
//
// Every one of them ultimately asks the OS to open a URL. On macOS that is
// `open <url>`; on Linux `xdg-open`, and most respect $BROWSER. So the agent
// writes a tiny shim, puts it FIRST on the child's PATH, and points $BROWSER at
// it. When the CLI opens its browser, the shim records the URL and exits 0 —
// the CLI believes a browser launched and carries on waiting for the callback,
// which is exactly the state we want it in.
//
// This is not interception of someone else's traffic: it is the agent choosing
// which browser its OWN child process uses, on the user's own machine, which is
// what $BROWSER exists for.
//
// The captured URL then goes to whichever surface the user is on — phone, web,
// TV — and the callback still lands on this machine's localhost, so the CLI
// completes normally and mints the SAME token it would have locally. No flag
// changes, no token-type downgrade, and it works for a CLI that prints nothing.

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// browserInterceptor is a per-session shim directory plus the file the shim
// writes captured URLs into.
type browserInterceptor struct {
	dir     string // temp dir holding the shim executables
	urlFile string // newline-delimited URLs, appended by the shim
}

// newBrowserInterceptor writes the shim for the current platform.
//
// The shim is deliberately dumb: append any http(s) argument to a file, exit 0.
// It must never fail, never block, and never write to stdout — a chatty shim
// would land in the CLI's own output and confuse the reader that scans it.
func newBrowserInterceptor(sessionID string) (*browserInterceptor, error) {
	dir, err := os.MkdirTemp("", "yaver-browser-shim-")
	if err != nil {
		return nil, fmt.Errorf("create shim dir: %w", err)
	}
	urlFile := filepath.Join(dir, "captured-urls")

	script := "#!/bin/sh\n" +
		"# Yaver browser shim. Records the URL a runner CLI wants to open so the\n" +
		"# user can complete the flow from another device, then exits 0 so the CLI\n" +
		"# believes a browser launched and keeps waiting for its callback.\n" +
		"for arg in \"$@\"; do\n" +
		"  case \"$arg\" in\n" +
		"    http://*|https://*) printf '%s\\n' \"$arg\" >> " + shQuoteShimPath(urlFile) + " ;;\n" +
		"  esac\n" +
		"done\n" +
		"exit 0\n"

	// Cover every name a CLI might reach for. `open` is macOS; `xdg-open`,
	// `www-browser` and `sensible-browser` are the Linux conventions. Writing
	// all of them costs nothing and removes a whole class of "worked on my
	// machine" failure.
	names := []string{"open", "xdg-open", "www-browser", "sensible-browser", "yaver-browser-shim"}
	if runtime.GOOS == "windows" {
		names = []string{"yaver-browser-shim"} // POSIX sh shim is meaningless there
	}
	for _, name := range names {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
			_ = os.RemoveAll(dir)
			return nil, fmt.Errorf("write shim %s: %w", name, err)
		}
	}
	return &browserInterceptor{dir: dir, urlFile: urlFile}, nil
}

// env returns the environment additions that route the child's browser opens
// through the shim. PATH is prepended so `open`/`xdg-open` resolve here first;
// BROWSER is set for the CLIs that honour it.
func (b *browserInterceptor) env(parent []string) []string {
	if b == nil {
		return parent
	}
	shim := filepath.Join(b.dir, "yaver-browser-shim")
	out := make([]string, 0, len(parent)+2)
	replacedPath := false
	for _, kv := range parent {
		if strings.HasPrefix(kv, "PATH=") {
			out = append(out, "PATH="+b.dir+string(os.PathListSeparator)+strings.TrimPrefix(kv, "PATH="))
			replacedPath = true
			continue
		}
		if strings.HasPrefix(kv, "BROWSER=") {
			continue // ours wins
		}
		out = append(out, kv)
	}
	if !replacedPath {
		out = append(out, "PATH="+b.dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	}
	out = append(out, "BROWSER="+shim)
	return out
}

// waitForURL blocks until the shim records a URL or the budget expires.
// Returns "" on timeout — the caller decides what that means, because "no URL"
// is a different failure from "the CLI refused", and conflating them is how a
// user ends up staring at a spinner.
func (b *browserInterceptor) waitForURL(budget time.Duration) string {
	if b == nil {
		return ""
	}
	deadline := time.Now().Add(budget)
	for time.Now().Before(deadline) {
		if u := b.lastURL(); u != "" {
			return u
		}
		time.Sleep(400 * time.Millisecond)
	}
	return ""
}

// lastURL returns the most recently captured URL, or "".
func (b *browserInterceptor) lastURL() string {
	if b == nil {
		return ""
	}
	raw, err := os.ReadFile(b.urlFile)
	if err != nil {
		return ""
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if u := strings.TrimSpace(lines[i]); strings.HasPrefix(u, "http") {
			return u
		}
	}
	return ""
}

// cleanup removes the shim directory. Safe to call twice.
func (b *browserInterceptor) cleanup() {
	if b == nil || b.dir == "" {
		return
	}
	_ = os.RemoveAll(b.dir)
	b.dir = ""
}

// shQuoteShimPath single-quotes a path for embedding in the generated /bin/sh
// shim. Paths come from os.MkdirTemp so they are tame, but an unquoted path in
// a generated script is how command injection starts, and a temp dir is
// attacker-adjacent on a shared machine. Named distinctly from env.go's
// shellQuote so the two never drift into each other.
func shQuoteShimPath(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
