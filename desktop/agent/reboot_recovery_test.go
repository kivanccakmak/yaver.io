package main

import (
	"strings"
	"testing"
)

// THE test. A machine keeps answering for several seconds after it accepts a
// reboot, so "it answered → recovered" reports success before the box has even
// started going down. Recovery must require having WATCHED it disappear.
func TestReachableWithoutEverGoingDownIsNotRecovery(t *testing.T) {
	p := RebootProbe{ElapsedSeconds: 2, ETASeconds: 60, Reachable: true, SawUnreachable: false}
	got := RebootProgressFor(p)
	if got.Phase == RebootPhaseRecovered {
		t.Fatal("a machine that never went down cannot be 'recovered' — the reboot has not taken hold yet")
	}
	if got.Phase != RebootPhaseIssued {
		t.Errorf("phase = %q, want %q", got.Phase, RebootPhaseIssued)
	}
	if got.Done {
		t.Error("issued phase must not be terminal — the caller has to keep polling")
	}
}

func TestRecoveredOnlyAfterGoingDownAndReturning(t *testing.T) {
	p := RebootProbe{ElapsedSeconds: 58, ETASeconds: 60, Reachable: true, SawUnreachable: true, MachineName: "mini"}
	got := RebootProgressFor(p)
	if got.Phase != RebootPhaseRecovered {
		t.Fatalf("phase = %q, want recovered", got.Phase)
	}
	if !got.Done {
		t.Error("recovered must be terminal")
	}
	if !strings.Contains(got.Headline, "mini") {
		t.Errorf("headline should name the machine; got %q", got.Headline)
	}
	// The user just lost their dev servers. Say so — they will otherwise
	// wonder why the preview is blank.
	if !strings.Contains(strings.ToLower(got.Detail), "restart") {
		t.Errorf("recovery copy must tell the user their dev servers are gone; got %q", got.Detail)
	}
}

// Being unreachable mid-reboot is the healthy middle, not an error.
func TestUnreachableWithinBudgetReadsAsProgress(t *testing.T) {
	p := RebootProbe{ElapsedSeconds: 20, ETASeconds: 60, Reachable: false, SawUnreachable: true, MachineName: "box"}
	got := RebootProgressFor(p)
	if got.Phase != RebootPhaseDown {
		t.Fatalf("phase = %q, want down", got.Phase)
	}
	if got.Done {
		t.Error("still rebooting — must not be terminal")
	}
	if got.RemainingSeconds != 40 {
		t.Errorf("remaining = %d, want 40", got.RemainingSeconds)
	}
	// A bounded expectation is the whole point: the user must be able to tell
	// "waiting" from "hung".
	if !strings.Contains(got.Detail, "40s") {
		t.Errorf("detail must carry the bounded expectation; got %q", got.Detail)
	}
	if !strings.Contains(strings.ToLower(got.Detail), "expected") {
		t.Errorf("being offline mid-reboot must read as expected, not as failure; got %q", got.Detail)
	}
}

// Past the grace budget we tell the truth — without claiming the box is dead.
func TestOverdueIsHonestButNotFatal(t *testing.T) {
	p := RebootProbe{ElapsedSeconds: 200, ETASeconds: 60, Reachable: false, SawUnreachable: true, MachineName: "pi"}
	got := RebootProgressFor(p)
	if got.Phase != RebootPhaseOverdue {
		t.Fatalf("phase = %q, want overdue at 200s against a 60s eta", got.Phase)
	}
	if got.Remedy == "" {
		t.Fatal("an unhappy state must hand the user something to do")
	}
	if got.Done {
		t.Error("overdue must NOT be terminal — the machine may still come back, and we keep watching")
	}
	// Do not overclaim. A slow boot is not a broken machine.
	if !strings.Contains(strings.ToLower(got.Detail), "not proof") {
		t.Errorf("overdue must not assert the machine is broken; got %q", got.Detail)
	}
}

// The grace factor must actually buy time — a warning at exactly the ETA would
// fire on healthy reboots and train the user to ignore it.
func TestNotOverdueImmediatelyAfterETA(t *testing.T) {
	p := RebootProbe{ElapsedSeconds: 61, ETASeconds: 60, Reachable: false, SawUnreachable: true}
	if got := RebootProgressFor(p); got.Phase != RebootPhaseDown {
		t.Errorf("phase at 61s vs 60s eta = %q, want still 'down' (grace factor %d)", got.Phase, rebootOverdueGraceFactor)
	}
	p.ElapsedSeconds = 121
	if got := RebootProgressFor(p); got.Phase != RebootPhaseOverdue {
		t.Errorf("phase at 121s vs 60s eta = %q, want overdue", got.Phase)
	}
}

// A machine that comes back AFTER being declared overdue must still be reported
// as recovered — overdue is not a trap state.
func TestRecoveryWinsOverOverdue(t *testing.T) {
	p := RebootProbe{ElapsedSeconds: 400, ETASeconds: 60, Reachable: true, SawUnreachable: true}
	got := RebootProgressFor(p)
	if got.Phase != RebootPhaseRecovered {
		t.Fatalf("a late return is still a return; phase = %q", got.Phase)
	}
	if !got.Done {
		t.Error("recovered must be terminal even when late")
	}
}

func TestEveryPhaseSaysSomething(t *testing.T) {
	cases := []RebootProbe{
		{ElapsedSeconds: 1, ETASeconds: 60, Reachable: true},
		{ElapsedSeconds: 30, ETASeconds: 60, SawUnreachable: true},
		{ElapsedSeconds: 90, ETASeconds: 60, Reachable: true, SawUnreachable: true},
		{ElapsedSeconds: 500, ETASeconds: 60, SawUnreachable: true},
		{ElapsedSeconds: 0, ETASeconds: 0}, // no eta supplied — must still narrate
	}
	for _, p := range cases {
		got := RebootProgressFor(p)
		if got.Headline == "" {
			t.Errorf("%+v: empty headline — a silent wait is the bug we are fixing", p)
		}
		if got.Detail == "" {
			t.Errorf("%+v: empty detail — the user needs the bounded expectation", p)
		}
		if got.Phase == "" {
			t.Errorf("%+v: empty phase", p)
		}
	}
}

// A missing ETA must not produce a nonsense countdown.
func TestMissingETAFallsBackToADefault(t *testing.T) {
	got := RebootProgressFor(RebootProbe{ElapsedSeconds: 10, ETASeconds: 0, SawUnreachable: true})
	if got.RemainingSeconds != rebootETALinuxSeconds-10 {
		t.Errorf("remaining = %d, want %d", got.RemainingSeconds, rebootETALinuxSeconds-10)
	}
}

func TestRemainingNeverGoesNegative(t *testing.T) {
	got := RebootProgressFor(RebootProbe{ElapsedSeconds: 300, ETASeconds: 60, SawUnreachable: true})
	if got.RemainingSeconds != 0 {
		t.Errorf("remaining = %d, want 0", got.RemainingSeconds)
	}
}

func TestHumanizeRebootSeconds(t *testing.T) {
	cases := map[int]string{0: "0s", 45: "45s", 60: "1m", 90: "1m 30s", 120: "2m", -5: "0s"}
	for in, want := range cases {
		if got := humanizeRebootSeconds(in); got != want {
			t.Errorf("humanizeRebootSeconds(%d) = %q, want %q", in, got, want)
		}
	}
}
