package main

import (
	"strings"
	"testing"
)

// The remained.md P0 contract: the session must expose WHEN the CLI last
// said anything, so a surface can render "CLI alive, no URL yet — last
// output 12s ago" instead of an undifferentiated spinner. A session whose
// scanner consumed a line must carry a non-zero LastOutputAt.
func TestScanRunnerBrowserAuthOutputTracksLastOutput(t *testing.T) {
	sess := newRunnerBrowserAuthSession("claude", tenantRuntime{})
	scanRunnerBrowserAuthOutput(sess, strings.NewReader("Preparing sign-in…\n"))

	snap := sess.snapshot()
	if snap.LastOutputAt == 0 {
		t.Fatal("LastOutputAt stayed 0 after the CLI produced output")
	}
	if snap.Detail != "Preparing sign-in…" {
		t.Fatalf("Detail = %q, want the sanitized last line", snap.Detail)
	}
}

// ACP audit 2026-08-12, §4: opencode's headless ChatGPT login is an RFC 8628
// device-code flow ("Go to: https://auth.openai.com/codex/device" +
// "Enter code: MWJI-A4WH0"). The scanner must capture BOTH into OpenURL and
// Code exactly like codex/kimi. Regression guard: if the opencode case is
// ever dropped from the capture gate again, this fails.
func TestScanRunnerBrowserAuthOutputCapturesOpenCodeDeviceFlow(t *testing.T) {
	sess := newRunnerBrowserAuthSession("opencode", tenantRuntime{})
	scanRunnerBrowserAuthOutput(sess, strings.NewReader(
		"\x1b[0m\n  Go to: https://auth.openai.com/codex/device\n  Enter code: MWJI-A4WH0\n  Waiting for authorization...\n",
	))

	snap := sess.snapshot()
	if snap.OpenURL != "https://auth.openai.com/codex/device" {
		t.Fatalf("OpenURL = %q, want the device URL", snap.OpenURL)
	}
	if snap.Code != "MWJI-A4WH0" {
		t.Fatalf("Code = %q, want the captured device code", snap.Code)
	}
	if snap.Status != "awaiting_browser" {
		t.Fatalf("Status = %q, want awaiting_browser after URL+code capture", snap.Status)
	}
}
