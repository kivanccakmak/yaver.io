package main

import (
	"strings"
	"testing"
	"time"
)

// agent_update_idle_test.go — both failure modes have ALREADY SHIPPED, so both
// get a negative control that reproduces them on purpose.
//
//	before 2026-07-17  "only when idle"  → a permanently-busy box never updated
//	after  2026-07-17  "always"          → an update killed the user's task
//
// A guard nobody has watched fail is a guess. Each test below has been run
// against a deliberately-broken decideUpdateWindow.

func busy(n int) []updateBusyReason {
	return []updateBusyReason{{Kind: "tasks", Count: n, Detail: "1 coding task is running"}}
}

// An idle box installs immediately. The whole point is not to be slower than
// before when there is nothing to protect.
func TestUpdateWindow_IdleAppliesImmediately(t *testing.T) {
	d := decideUpdateWindow(time.Now(), "1.99.403", nil, time.Time{}, updateDeferralCeiling)
	if !d.Apply || d.Code != updateWindowIdle {
		t.Fatalf("idle box did not apply: %+v", d)
	}
}

// NEGATIVE CONTROL for the CURRENT bug: a busy box must not restart. Remove the
// busy check (return Apply:true unconditionally) and this fails.
func TestBusyBoxDoesNotRestartBeforeCeiling(t *testing.T) {
	now := time.Now()
	d := decideUpdateWindow(now, "1.99.403", busy(1), now.Add(-2*time.Hour), updateDeferralCeiling)
	if d.Apply {
		t.Fatalf("a box with a running task was told to restart after only 2h of a %v ceiling: %+v",
			updateDeferralCeiling, d)
	}
	if d.Code != updateWindowDeferred {
		t.Fatalf("expected %s, got %s", updateWindowDeferred, d.Code)
	}
	// The reason has to be renderable, not a debug string: a surface shows this
	// to a human instead of a version number with no explanation.
	if d.Reason == "" || d.ForceAt.IsZero() {
		t.Fatalf("a deferral with no reason or no outer bound is a spinner: %+v", d)
	}
}

// NEGATIVE CONTROL for the PRE-2026-07-17 bug: a box that is busy forever must
// STILL update. Remove the ceiling (or set it to 0 and return Apply:false) and
// this fails — which is exactly the starvation that got the idle gate deleted.
func TestPermanentlyBusyBoxStillUpdates(t *testing.T) {
	start := time.Now()
	var applied bool
	// Simulate a box that never goes idle, checked every 10 minutes for 3 days.
	for elapsed := time.Duration(0); elapsed < 72*time.Hour; elapsed += 10 * time.Minute {
		d := decideUpdateWindow(start.Add(elapsed), "1.99.403", busy(3), start, updateDeferralCeiling)
		if d.Apply {
			applied = true
			if d.Code != updateWindowForced {
				t.Fatalf("expected the ceiling to force it, got %s", d.Code)
			}
			// It must SAY what it is about to cost. Restarting into a running
			// task silently is the behaviour this whole file replaces.
			if d.Reason == "" {
				t.Fatal("forced update did not state what it would interrupt")
			}
			if elapsed < updateDeferralCeiling {
				t.Fatalf("forced after %v, before the %v ceiling", elapsed, updateDeferralCeiling)
			}
			break
		}
	}
	if !applied {
		t.Fatalf("a permanently busy box NEVER updated in 72h — that is the starvation bug the idle gate was deleted for")
	}
}

// A new version resets the clock. Without keying on version, a box that waited
// 11h for v403 would carry that impatience into v404 and restart almost
// immediately on a version that had waited no time at all.
func TestDeferralClockResetsOnNewVersion(t *testing.T) {
	var tr deferredUpdateTracker
	start := time.Now()

	d := tr.Decide(start, "1.99.403", busy(1), updateDeferralCeiling)
	if d.Apply {
		t.Fatal("first busy decision should defer")
	}
	// 11h later, still busy, still v403 — close to the ceiling but not past it.
	if d := tr.Decide(start.Add(11*time.Hour), "1.99.403", busy(1), updateDeferralCeiling); d.Apply {
		t.Fatal("applied before the ceiling")
	}
	// A NEW version arrives. Its own clock starts now, so it must not inherit
	// the 11 hours v403 had accumulated.
	if d := tr.Decide(start.Add(11*time.Hour+time.Minute), "1.99.404", busy(1), updateDeferralCeiling); d.Apply {
		t.Fatal("a brand-new version was forced through immediately — it inherited the previous version's deferral clock")
	}
}

// Applying clears the clock, so a failed install that gets retried starts a
// fresh window instead of re-forcing on every tick forever.
func TestApplyingClearsTheDeferralClock(t *testing.T) {
	var tr deferredUpdateTracker
	start := time.Now()
	tr.Decide(start, "1.99.403", busy(1), updateDeferralCeiling)
	if d := tr.Decide(start.Add(13*time.Hour), "1.99.403", busy(1), updateDeferralCeiling); !d.Apply {
		t.Fatal("should have forced past the ceiling")
	}
	// Same version, still busy, immediately after: the clock restarted, so this
	// must defer rather than force again.
	if d := tr.Decide(start.Add(13*time.Hour+time.Second), "1.99.403", busy(1), updateDeferralCeiling); d.Apply {
		t.Fatal("re-forced immediately after applying — the deferral clock was not cleared")
	}
}

// The reason a user reads must name what is actually holding the update, in
// plain language. "Update deferred" is a spinner.
func TestDeferralReasonNamesWhatIsRunning(t *testing.T) {
	reasons := []updateBusyReason{
		{Kind: "tasks", Count: 2, Detail: "2 coding tasks are running"},
		{Kind: "support", Count: 1, Detail: "a support session is live"},
	}
	d := decideUpdateWindow(time.Now(), "1.99.403", reasons, time.Time{}, updateDeferralCeiling)
	if d.Apply {
		t.Fatal("busy box applied")
	}
	for _, want := range []string{"1.99.403", "2 coding tasks are running", "a support session is live"} {
		if !strings.Contains(d.Reason, want) {
			t.Fatalf("reason %q does not mention %q", d.Reason, want)
		}
	}
}

// Probes must be able to say "not busy" without the caller having to filter,
// and re-registering a name must replace rather than duplicate.
func TestBusyProbeRegistryReplacesByName(t *testing.T) {
	updateBusyProbesMu.Lock()
	saved := updateBusyProbes
	updateBusyProbes = nil
	updateBusyProbesMu.Unlock()
	t.Cleanup(func() {
		updateBusyProbesMu.Lock()
		updateBusyProbes = saved
		updateBusyProbesMu.Unlock()
	})

	RegisterUpdateBusyProbe("x", func() updateBusyReason { return updateBusyReason{Count: 0} })
	if got := collectUpdateBusyReasons(); len(got) != 0 {
		t.Fatalf("a zero-count probe leaked into the busy list: %+v", got)
	}
	RegisterUpdateBusyProbe("x", func() updateBusyReason { return updateBusyReason{Count: 1, Detail: "d"} })
	RegisterUpdateBusyProbe("x", func() updateBusyReason { return updateBusyReason{Count: 1, Detail: "d"} })
	if got := collectUpdateBusyReasons(); len(got) != 1 {
		t.Fatalf("re-registering the same name duplicated it: %+v", got)
	}
}
