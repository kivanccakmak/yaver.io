package main

// doctor_browser_lane_launch_test.go — a browser that never started must be
// reported as a browser problem, not as a navigation problem.
//
// MEASURED ON THE OWNER'S BOX, 2026-08-05, driving the RN-web app at sfmg
// through the browser lane. The phone showed:
//
//	Browser lane stopped at navigate
//	navigation failed: chrome failed to start: cannot create temporary
//	directory for the root file system: No such file or directory
//	Remedy: the preview URL refused the connection — the dev server bound a
//	different port, or died after /dev/start returned; check /dev/status …
//
// Two defects in one screen. Chrome never started (the allocator did not pin
// ExecPath, so chromedp found /usr/bin/chromium-browser — the SNAP REDIRECTOR —
// while /usr/bin/google-chrome sat right there working). And the stage was
// misclassified, because the old test looked only for "exec"/"executable" in the
// message and this failure contains neither — so the remedy shown was about
// dev-server ports, sending the user to inspect something healthy.

import (
	"errors"
	"os"
	"strings"
	"testing"
)

// TestSnapChromeFailureIsABrowserStageNotNavigate pins the classification against
// the EXACT string the snap build produces.
func TestSnapChromeFailureIsABrowserStageNotNavigate(t *testing.T) {
	snap := errors.New("chrome failed to start: cannot create temporary directory for the root file system: No such file or directory")

	reason := browserWindowLaunchErrorReason(snap)
	if reason == "" {
		t.Fatal("the snap signature must be recognised as a launch failure — otherwise it falls through to StageNavigate and the phone blames the dev server")
	}
	if reason != ReasonBrowserWindowChromeSnapConfined {
		t.Errorf("reason = %q, want %q: the remedy differs (install the UNCONFINED build, not 'check /dev/status')",
			reason, ReasonBrowserWindowChromeSnapConfined)
	}

	// The words the OLD classifier keyed on are absent — which is precisely why
	// it misfired. Pin that, so nobody "simplifies" back to a substring check.
	low := strings.ToLower(snap.Error())
	if strings.Contains(low, "executable") {
		t.Error("this fixture must NOT contain 'executable' — it is the case the old check missed")
	}
}

// TestBrowserLaneDoctorPinsTheBinary is the structural guard. The allocator can
// be reverted to DefaultExecAllocatorOptions in one line and every behavioural
// test still passes, because chromedp then silently picks whatever it finds —
// which is how this shipped.
func TestBrowserLaneDoctorPinsTheBinary(t *testing.T) {
	src := readAgentSource(t, "doctor_browser_lane.go")
	if !strings.Contains(src, "chromedp.ExecPath(cp)") {
		t.Error("the browser-lane doctor must pin the probed binary: without ExecPath, chromedp searches on its own and finds the snap redirector on any box that has one")
	}
	if !strings.Contains(src, "browserWindowLaunchErrorReason(err)") {
		t.Error("the doctor must share the launch-failure vocabulary rather than re-deriving it, or the two lanes disagree about the same failure")
	}
}

// readAgentSource reads a file from this package for the structural guards.
func readAgentSource(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(b)
}
