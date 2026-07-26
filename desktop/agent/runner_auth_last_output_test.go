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
