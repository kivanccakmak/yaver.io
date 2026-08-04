package main

// browser_window_gap_test.go — five codes, five different remedies.
//
// They were five codes precisely because the remedies differ, and then all five
// were interpolated into one error STRING, so no surface could tell them apart
// without regexing prose. That is the drift reason codes exist to abolish, and it
// is why all five appeared in the 2026-08-04 audit as emitted-into-silence.
//
// The distinctions that matter, and that a single "browser problem" cannot carry:
//   * chrome_missing        install it — a real, deterministic route.
//   * chrome_snap_confined  a browser IS installed; installing more snaps cannot
//                           help, so an installer button would be a no-op.
//   * profile_lock          another process holds the profile; ending it is the
//                           fix, not reinstalling.
//   * runtime_dir           filesystem permissions or space; a reinstall changes
//                           nothing.
//   * launch_failed         it exists and exits; the launch output is the evidence.

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBrowserWindowLaunchErrorKeepsItsSentence(t *testing.T) {
	inner := errors.New("exec: \"google-chrome\": executable file not found in $PATH")
	err := browserWindowLaunchError(inner)

	// Every existing caller only prints this. It must not change.
	if !strings.Contains(err.Error(), "launch headless chromium") {
		t.Errorf("the shipped sentence must survive verbatim: %q", err.Error())
	}
	// And the reason must now be reachable as a FIELD, not by regexing that text.
	var typed *BrowserWindowLaunchError
	if !errors.As(err, &typed) {
		t.Fatalf("want *BrowserWindowLaunchError so clients classify instead of regexing; got %T", err)
	}
	if typed.Reason == "" {
		t.Error("Reason must be set — carrying the code only inside the sentence is what left five codes unread")
	}
	// Unwrap keeps errors.Is working for whatever the caller already checked.
	if !errors.Is(err, inner) {
		t.Error("the cause must stay unwrappable")
	}
}

func TestBrowserWindowGapsDifferPerReason(t *testing.T) {
	// A snap-confined browser must NEVER be offered an installer: one is already
	// installed, so the button could not help and would teach the user that
	// Yaver's buttons do not work.
	snap := browserWindowGap(ReasonBrowserWindowChromeSnapConfined)
	if snap == nil {
		t.Fatal("snap-confined must produce a gap")
	}
	if snap.Fix != nil {
		t.Error("snap-confined must NOT offer an install route — a browser is already installed")
	}
	if snap.Constraint == "" {
		t.Error("a gap with no fix MUST carry a constraint, or it is a dead end with a sentence")
	}
	if !strings.Contains(strings.ToLower(snap.Constraint), "unconfined") {
		t.Errorf("the constraint must name the actual remedy (the unconfined build): %q", snap.Constraint)
	}

	// Every reason must produce SOMETHING with either a fix or a constraint —
	// the one shape CapabilityGap exists to make impossible is neither.
	for _, code := range []string{
		ReasonBrowserWindowChromeMissing,
		ReasonBrowserWindowChromeSnapConfined,
		ReasonBrowserWindowChromeProfile,
		ReasonBrowserWindowChromeRuntimeDir,
		ReasonBrowserWindowChromeLaunch,
	} {
		gap := browserWindowGap(code)
		if gap == nil {
			t.Errorf("%s produced no gap", code)
			continue
		}
		if gap.Code != code {
			t.Errorf("%s: gap carries code %q — a client switching on it would classify the wrong failure", code, gap.Code)
		}
		if gap.Fix == nil && strings.TrimSpace(gap.Constraint) == "" {
			t.Errorf("%s: neither Fix nor Constraint", code)
		}
		if strings.TrimSpace(gap.Summary) == "" {
			t.Errorf("%s: no summary, so no surface can render a named cause", code)
		}
	}

	// The five summaries must actually be different sentences. Five codes that
	// all say "browser problem" would be one code wearing five hats.
	seen := map[string]string{}
	for _, code := range []string{
		ReasonBrowserWindowChromeMissing,
		ReasonBrowserWindowChromeSnapConfined,
		ReasonBrowserWindowChromeProfile,
		ReasonBrowserWindowChromeRuntimeDir,
		ReasonBrowserWindowChromeLaunch,
	} {
		if gap := browserWindowGap(code); gap != nil {
			if prev, dup := seen[gap.Summary]; dup {
				t.Errorf("%s and %s share a summary (%q) — the codes are distinct because the REMEDIES are", code, prev, gap.Summary)
			}
			seen[gap.Summary] = code
		}
	}

	// An unknown reason must not fabricate a gap.
	if browserWindowGap("browser_window.something_new") != nil {
		t.Error("an unrecognised reason must not invent a remedy")
	}
}

// TestBrowserWindowGapReachesTheHTTPReply — the gap must leave the process.
//
// Caught during the change that added it: browserWindowLaunchError produced a
// perfectly good CapabilityGap and the session-create handler replied
// `jsonError(w, 400, err.Error())`, so the gap was dropped and the code travelled
// inside the sentence again — the precise state these five codes started in.
//
// A typed error is not a wire. This asserts the handler helper carries it, so the
// producer cannot silently become useful-to-nobody a second time.
func TestBrowserWindowGapReachesTheHTTPReply(t *testing.T) {
	rec := httptest.NewRecorder()
	inner := errors.New(`exec: "google-chrome": executable file not found in $PATH`)
	remoteRuntimeCreateError(rec, browserWindowLaunchError(inner))

	var body map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode reply: %v", err)
	}
	if body["code"] == nil || body["code"] == "" {
		t.Errorf("reply carries no code — a client must classify without regexing %q", body["error"])
	}
	if body["capabilityGap"] == nil {
		t.Fatal("reply carries no capabilityGap: the typed error was built and then thrown away at the HTTP layer")
	}
	// And an ordinary error must still look exactly as it always did.
	plain := httptest.NewRecorder()
	remoteRuntimeCreateError(plain, errors.New("some other failure"))
	var pb map[string]interface{}
	_ = json.Unmarshal(plain.Body.Bytes(), &pb)
	if pb["capabilityGap"] != nil {
		t.Error("a non-browser error must not grow a gap")
	}
	if pb["error"] != "some other failure" {
		t.Errorf("the plain path must be unchanged, got %v", pb["error"])
	}
}
