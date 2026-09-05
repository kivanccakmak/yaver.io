package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// A binary that resolves on PATH but cannot run is NOT a browser. This is the
// Ubuntu snap-stub case: `chromium-browser` installs, resolves, and then fails
// to launch — the inventory says yes, the operation says no.
func TestChromeBinaryUsableRejectsAStubThatCannotRun(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script stub is POSIX-only")
	}
	dir := t.TempDir()

	stub := filepath.Join(dir, "chromium-browser")
	if err := os.WriteFile(stub, []byte("#!/bin/sh\necho 'snap not available'\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if chromeBinaryUsable(stub) {
		t.Error("a stub that exits non-zero must not count as a usable browser")
	}

	real := filepath.Join(dir, "google-chrome")
	if err := os.WriteFile(real, []byte("#!/bin/sh\necho 'Google Chrome 150.0.7871.181'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !chromeBinaryUsable(real) {
		t.Error("a binary reporting a Chrome version must count as usable")
	}

	// Exits 0 but is not a browser — e.g. a wrapper that prints usage.
	impostor := filepath.Join(dir, "chromium")
	if err := os.WriteFile(impostor, []byte("#!/bin/sh\necho 'usage: install a browser'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if chromeBinaryUsable(impostor) {
		t.Error("exit 0 alone must not qualify — the output has to name the browser")
	}
}

func TestWindowsBrowserPathsIncludeBuiltInEdgeBeforeChrome(t *testing.T) {
	env := map[string]string{
		"ProgramFiles":      `C:\Program Files`,
		"ProgramFiles(x86)": `C:\Program Files (x86)`,
		"LOCALAPPDATA":      `C:\Users\friend\AppData\Local`,
	}
	paths := windowsBrowserInstallPaths(func(key string) string { return env[key] })
	if len(paths) < 6 {
		t.Fatalf("browser paths = %v, want Edge and Chrome machine/user locations", paths)
	}
	if got := paths[0]; got != `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` {
		t.Fatalf("first browser path = %q, want built-in Edge", got)
	}
	if !strings.Contains(strings.ToLower(strings.Join(paths, "\n")), `google\chrome\application\chrome.exe`) {
		t.Fatalf("Chrome default locations missing: %v", paths)
	}
}

func TestEdgeVersionOutputCountsAsChromiumBrowser(t *testing.T) {
	if !chromeVersionOutputUsable("Microsoft Edge 150.0.0000.0") {
		t.Fatal("stock Windows Edge must count as a usable Chromium browser")
	}
	if chromeVersionOutputUsable("Microsoft installer 1.0") {
		t.Fatal("an unrelated successful command must not count as a browser")
	}
}

// The apt path must add Google's repo BEFORE installing, or it fails with
// "Unable to locate package google-chrome-stable" on stock Debian/Ubuntu.
func TestChromeAptScriptAddsTheRepoBeforeInstalling(t *testing.T) {
	repoAt := strings.Index(chromeAptScript, "sources.list.d/google-chrome.list")
	installAt := strings.Index(chromeAptScript, "apt-get install -y google-chrome-stable")
	if repoAt < 0 || installAt < 0 {
		t.Fatalf("script lost a required step:\n%s", chromeAptScript)
	}
	if repoAt > installAt {
		t.Error("the repo must be added before the install, or apt cannot find the package")
	}
	if !strings.Contains(chromeAptScript, "signed-by=/etc/apt/keyrings/") {
		t.Error("must use a keyring — apt-key is removed on modern Debian/Ubuntu")
	}
	// An amd64-pinned line installs nothing on the arm boxes Yaver runs on.
	if !strings.Contains(chromeAptScript, "dpkg --print-architecture") {
		t.Error("architecture must be resolved at run time, not hardcoded")
	}
	if !strings.Contains(chromeAptScript, "apt-get update") {
		t.Error("must refresh the index after adding the repo")
	}
}
