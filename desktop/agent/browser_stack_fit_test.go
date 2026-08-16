package main

// browser_stack_fit_test.go — the properties that make CDP + Pion the right
// remote-box stack for THIS use case, pinned so a future "let's switch to X"
// has to argue with measurements instead of taste.
//
// THE DECISION, and the analysis behind it (2026-08-05).
//
// Our lane is not "stream a desktop". It is: render ONE PAGE at a caller-chosen
// viewport, send H.264 over WebRTC, and inject clicks, keys and MULTI-TOUCH
// back. The obvious alternatives — Selkies-GStreamer, Neko — are desktop
// streamers: they capture an X11 display and inject through X11/uinput. That
// costs an Xvfb + GStreamer stack on a 4 GB box, and it LOSES fidelity where we
// need it most, because a pinch is not expressible as X11 input the way
// Input.dispatchTouchEvent expresses it natively.
//
// So the fragility was never the library. Every browser failure this session was
// binary selection or install provisioning:
//   * the npm install plan provisioned the snap Chromium (install_cmd.go)
//   * three launchers did not pin ExecPath, so chromedp found the snap stub
//   * a launch failure was misreported as a navigation failure
// Those are now fixed at the source, and these tests keep the properties that
// made the decision true.

import (
	"strings"
	"testing"
)

// TestInputIsDispatchedThroughCDPNotX11 — the capability that decides the stack.
//
// If input ever moves to an X11/uinput path, multi-touch degrades and the
// argument for staying off a desktop streamer disappears. Pin the CDP calls.
func TestInputIsDispatchedThroughCDPNotX11(t *testing.T) {
	src := readAgentSource(t, "remote_runtime_browser.go")
	for _, need := range []string{"DispatchTouchEvent", "DispatchMouseEvent"} {
		if !strings.Contains(src, need) {
			t.Errorf("remote_runtime_browser.go no longer uses %s — input through CDP is why this lane needs no X11 and can express a real pinch", need)
		}
	}
	// A desktop streamer would need these; if they ever appear, the trade-off
	// that justified CDP has changed and the decision must be re-argued.
	for _, banned := range []string{"uinput", "XTestFakeButtonEvent"} {
		if strings.Contains(src, banned) {
			t.Errorf("remote_runtime_browser.go references %s — X11-style injection cannot express multi-touch and reintroduces the Xvfb dependency this stack avoids", banned)
		}
	}
}

// TestVibePreviewPlanInstallsAnUnconfinedBrowser — the install-time root cause.
//
// `npm i -g yaver-cli` runs `yaver install vibe-preview`. When that plan named
// "chromium", a fresh Ubuntu box got the SNAP (no apt candidate → the `|| snap
// install` arm), and a snap Chromium cannot create its temp dir under a daemon.
// The preview browser a new user received could never capture a frame.
func TestVibePreviewPlanInstallsAnUnconfinedBrowser(t *testing.T) {
	for _, name := range vibePreviewPlanNames {
		if name == "chromium" {
			t.Fatal("the vibe-preview plan names \"chromium\", whose Linux step falls through to `snap install chromium` on stock Ubuntu — a confined build that cannot launch from a daemon. Use \"chrome\", which adds Google's apt repo and installs an unconfined google-chrome-stable.")
		}
	}
	found := false
	for _, name := range vibePreviewPlanNames {
		if name == "chrome" {
			found = true
		}
	}
	if !found {
		t.Error("the vibe-preview plan must provision a browser at all — it is what a fresh npm install relies on for any pixel capture")
	}
}

// TestCompositePlansHaveOneSourceOfTruth — the satisfaction check used to be a
// second hand-copied list, so the installer and "is it satisfied?" agreed with
// each other while both were wrong: a fresh box installed a broken browser AND
// reported itself satisfied.
func TestCompositePlansHaveOneSourceOfTruth(t *testing.T) {
	src := readAgentSource(t, "install_cmd.go")
	// The literal list must not reappear beside the plan var.
	if strings.Contains(src, `"vibe-preview":   {"chromium"`) || strings.Contains(src, `"vibe-preview": {"chromium"`) {
		t.Error("compositeInstallSatisfied carries its own copy of the vibe-preview list again — what gets installed must not be able to drift from what counts as installed")
	}
	if !strings.Contains(src, `"vibe-preview":   vibePreviewPlanNames`) {
		t.Error("compositeInstallSatisfied must reference vibePreviewPlanNames")
	}
}
