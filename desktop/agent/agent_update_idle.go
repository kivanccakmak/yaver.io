package main

import (
	"fmt"
	"math/rand"
	"sort"
	"strings"
	"sync"
	"time"
)

// When may an UNATTENDED update restart this agent?
//
// The history matters, because both obvious answers have already shipped and
// both were wrong:
//
//  1. "Only when idle" (before 2026-07-17). A box running a long autorun loop
//     is never idle, so it never updated at all — the machines under the most
//     load, which need fixes most, were the ones that never got them. That is
//     starvation, and it is why the gate was deleted.
//  2. "Whenever the timer fires" (2026-07-17 → now). Applying an update
//     restarts the agent, and a coding turn running at that moment dies with
//     it. The user is mid-work and the product kills their task to install
//     something they did not ask for. The log line even says so and does it
//     anyway:
//     "[auto-update] Periodic check — %d task(s) running; a new version will
//     restart the agent and end them"
//
// Neither is acceptable, and the choice between them is false. The rule that
// serves both is DEFER WITH A CEILING:
//
//   - Busy      → do not restart. Re-check soon (minutes, not hours) so the
//     update lands the moment the box goes quiet.
//   - Busy for longer than updateDeferralCeiling → apply anyway, and SAY what
//     it costs. Convergence still wins in the end; it just stops winning at
//     the user's expense on the first tick.
//
// Two properties this must keep, and both have a negative-control test in
// agent_update_idle_test.go — a guard nobody has watched fail is a guess:
//
//   - A busy box does NOT restart before the ceiling. (Break the busy check
//     and TestBusyBoxDoesNotRestartBeforeCeiling fails.)
//   - A box busy FOREVER still updates. (Break the ceiling and
//     TestPermanentlyBusyBoxStillUpdates fails — this is bug #1 above,
//     reproduced on purpose so it cannot come back.)
//
// The gate is consulted AFTER a newer version has been resolved and BEFORE
// anything disruptive runs — never before. Resolving a version is a cheap HTTP
// GET that interrupts nobody, and doing it first is what lets a surface say
// "v1.99.400 is ready, it will install when your task finishes" instead of the
// useless "an update may or may not exist and we didn't look".
//
// ATTENDED paths are NOT gated. `yaver update`, POST /agent/update, and a
// remote update request are the owner asking for it right now, by hand. Making
// them wait for idle would be the product overruling an explicit instruction.
// They report what they are about to interrupt; they do not refuse.

// updateDeferralCeiling bounds how long an automatic update may be held back
// by a busy box.
//
// 12h, chosen against the two failure modes rather than by taste: it is 6-12×
// autoUpdateCheckInterval, so only genuinely continuous load ever reaches it
// (a box that goes quiet for ten minutes in half a day updates during that
// window and never sees the ceiling), and it still satisfies the requirement
// that motivated the 1-2h cadence — "a box running a user's coding turns needs
// an agent fix the day it ships, not sometime tomorrow".
//
// The "within a minute" case from 2026-08-03 is NOT this timer's job. That is
// an attended push, and it belongs to the release-announce path — see
// agent_update_request.go. Do not shrink this constant to chase it.
const updateDeferralCeiling = 12 * time.Hour

// updateBusyReason is one named answer to "who is using this box right now".
//
// Named, not a bare bool, because the reason has to survive all the way to a
// surface. "Update deferred" is a spinner; "Update to v1.99.400 will install
// when your 2 running tasks finish" is a product. Kind is a stable code for
// clients to switch on; Detail is the sentence a human reads.
type updateBusyReason struct {
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
	Count  int    `json:"count,omitempty"`
}

// updateBusyProbe is a subsystem's own answer for whether it is in use.
//
// A registry rather than one function that reaches into every manager, because
// the alternative is a central list that drifts: exec sessions, support
// sessions, vibe capture and coding tasks live in four files with four
// different ownership models, and the ticker goroutine in main.go does not
// even hold a reference to the HTTP server that owns two of them. Each
// subsystem registers the truth it already knows, next to the state it already
// guards.
//
// A probe MUST be cheap and non-blocking — it runs inside the update decision.
// Returning a zero Count means "not busy".
type updateBusyProbe struct {
	Name string
	Fn   func() updateBusyReason
}

var (
	updateBusyProbesMu sync.Mutex
	updateBusyProbes   []updateBusyProbe
)

// RegisterUpdateBusyProbe adds a subsystem's busy answer. Re-registering the
// same name replaces it, so a restart-in-place or a test can rebind without
// accumulating duplicates.
func RegisterUpdateBusyProbe(name string, fn func() updateBusyReason) {
	if name == "" || fn == nil {
		return
	}
	updateBusyProbesMu.Lock()
	defer updateBusyProbesMu.Unlock()
	for i := range updateBusyProbes {
		if updateBusyProbes[i].Name == name {
			updateBusyProbes[i].Fn = fn
			return
		}
	}
	updateBusyProbes = append(updateBusyProbes, updateBusyProbe{Name: name, Fn: fn})
}

// collectUpdateBusyReasons asks every registered subsystem. Sorted by name so
// the reason string a user sees is stable between ticks — a status line that
// reorders itself reads as churn.
func collectUpdateBusyReasons() []updateBusyReason {
	updateBusyProbesMu.Lock()
	probes := make([]updateBusyProbe, len(updateBusyProbes))
	copy(probes, updateBusyProbes)
	updateBusyProbesMu.Unlock()

	var reasons []updateBusyReason
	for _, p := range probes {
		r := p.Fn()
		if r.Count <= 0 {
			continue
		}
		if r.Kind == "" {
			r.Kind = p.Name
		}
		reasons = append(reasons, r)
	}
	sort.Slice(reasons, func(i, j int) bool { return reasons[i].Kind < reasons[j].Kind })
	return reasons
}

// Stable codes for the decision, so a surface switches on a value instead of
// regexing a sentence. Mobile already carries three different relay-auth
// matchers because prose was the only signal; do not start a fourth family.
const (
	updateWindowIdle     = "update_window_idle"
	updateWindowDeferred = "update_window_deferred_busy"
	updateWindowForced   = "update_window_forced_past_ceiling"
)

// updateWindowDecision is the answer, with everything a caller needs to
// explain itself without recomputing anything.
type updateWindowDecision struct {
	Apply   bool               `json:"apply"`
	Code    string             `json:"code"`
	Reason  string             `json:"reason"`
	Busy    []updateBusyReason `json:"busy,omitempty"`
	ForceAt time.Time          `json:"forceAt,omitempty"`
	// DeferredFor is how long this update has been held back so far.
	DeferredFor time.Duration `json:"-"`
}

// decideUpdateWindow is the whole policy, as a pure function of its inputs.
//
// Pure on purpose: the logic that SHIPS is then the logic that is TESTED. The
// caller owns the clock, the busy list and the deferral bookkeeping, so a test
// can drive twelve hours of a permanently-busy box in microseconds and prove
// the ceiling actually fires — which is the only way to know that bug #1 above
// cannot return.
//
// firstDeferredAt is the zero time when this update has not been deferred yet.
func decideUpdateWindow(now time.Time, latestVersion string, busy []updateBusyReason, firstDeferredAt time.Time, ceiling time.Duration) updateWindowDecision {
	if len(busy) == 0 {
		return updateWindowDecision{
			Apply:  true,
			Code:   updateWindowIdle,
			Reason: fmt.Sprintf("Installing v%s — the agent is idle.", strings.TrimPrefix(latestVersion, "v")),
		}
	}

	summary := summarizeBusy(busy)

	// Never deferred before: start the clock now, and the ceiling is measured
	// from this moment rather than from some earlier tick we did not record.
	if firstDeferredAt.IsZero() {
		firstDeferredAt = now
	}
	deferredFor := now.Sub(firstDeferredAt)
	if deferredFor < 0 {
		deferredFor = 0
	}

	if ceiling > 0 && deferredFor >= ceiling {
		return updateWindowDecision{
			Apply:   true,
			Code:    updateWindowForced,
			Busy:    busy,
			ForceAt: firstDeferredAt.Add(ceiling),
			Reason: fmt.Sprintf(
				"Installing v%s now — it has waited %s for this box to go idle and %s is still active. The agent will restart and that will end them.",
				strings.TrimPrefix(latestVersion, "v"), roundDuration(deferredFor), summary),
			DeferredFor: deferredFor,
		}
	}

	return updateWindowDecision{
		Apply:   false,
		Code:    updateWindowDeferred,
		Busy:    busy,
		ForceAt: firstDeferredAt.Add(ceiling),
		Reason: fmt.Sprintf(
			"v%s is ready and will install when this box goes idle — %s right now. Installing would restart the agent and end them.",
			strings.TrimPrefix(latestVersion, "v"), summary),
		DeferredFor: deferredFor,
	}
}

// summarizeBusy renders the reasons as one human clause: "2 coding tasks and a
// support session are running".
func summarizeBusy(busy []updateBusyReason) string {
	if len(busy) == 0 {
		return "nothing"
	}
	parts := make([]string, 0, len(busy))
	for _, b := range busy {
		if b.Detail != "" {
			parts = append(parts, b.Detail)
			continue
		}
		parts = append(parts, fmt.Sprintf("%d %s", b.Count, b.Kind))
	}
	switch len(parts) {
	case 1:
		return parts[0]
	case 2:
		return parts[0] + " and " + parts[1]
	default:
		return strings.Join(parts[:len(parts)-1], ", ") + " and " + parts[len(parts)-1]
	}
}

func roundDuration(d time.Duration) time.Duration {
	if d >= time.Hour {
		return d.Round(time.Minute)
	}
	return d.Round(time.Second)
}

// registerDefaultUpdateBusyProbes wires the subsystems that mean "a human is
// mid-something". Called once from serve.
//
// Deliberately NOT a list of everything the agent does. A probe here has to
// mean "restarting right now would destroy work a person is waiting on" — a
// warm cache or an idle SSE subscriber does not qualify, and padding this list
// would recreate the starvation bug by making the box permanently "busy".
func registerDefaultUpdateBusyProbes(taskMgr *TaskManager) {
	if taskMgr != nil {
		RegisterUpdateBusyProbe("tasks", func() updateBusyReason {
			n := taskMgr.GetRunningTaskCount()
			if n <= 0 {
				return updateBusyReason{}
			}
			word := "tasks are"
			if n == 1 {
				word = "task is"
			}
			return updateBusyReason{
				Kind:   "tasks",
				Count:  n,
				Detail: fmt.Sprintf("%d coding %s running", n, word),
			}
		})
	}

	// A support session is a person watching their machine over the wire. A
	// restart drops them with no explanation, which is the exact "silent
	// serve" experience this repo keeps paying to remove.
	RegisterUpdateBusyProbe("support", func() updateBusyReason {
		if activeSupportSnapshot() == nil {
			return updateBusyReason{}
		}
		return updateBusyReason{Kind: "support", Count: 1, Detail: "a support session is live"}
	})

	// A live vibe capture means somebody is looking at a preview right now.
	// Restarting mid-capture kills the browser and the frames stop, which reads
	// as the product hanging.
	RegisterUpdateBusyProbe("preview", func() updateBusyReason {
		m := ActiveVibePreviewManager()
		if m == nil {
			return updateBusyReason{}
		}
		n := len(m.Status())
		if n <= 0 {
			return updateBusyReason{}
		}
		word := "previews are"
		if n == 1 {
			word = "preview is"
		}
		return updateBusyReason{Kind: "preview", Count: n, Detail: fmt.Sprintf("%d live %s streaming", n, word)}
	})
}

// updateBusyRetryInterval is how soon to look again while an update is held
// back. Minutes, not the 1-2h main cadence: the update is already downloaded
// in intent and only waiting for a quiet moment, so checking back on the hour
// would make a box that went idle at 12:01 sit stale until 13:00 for no
// reason. Jittered for the same fleet-spreading reason as the main interval.
func updateBusyRetryInterval() time.Duration {
	const min = 5 * time.Minute
	const spread = 5 * time.Minute
	return min + time.Duration(rand.Int63n(int64(spread)))
}

// deferredUpdateTracker remembers when the CURRENT pending version first got
// held back.
//
// Keyed by version on purpose. Without that key, a box busy for eleven hours
// waiting on v1.99.400 would carry that stale clock into v1.99.401 and restart
// almost immediately on a version that had waited no time at all — every new
// release inheriting the last one's impatience. A new version resets the
// ceiling, which is what "this update has been waiting 12h" is supposed to
// mean.
type deferredUpdateTracker struct {
	mu      sync.Mutex
	version string
	since   time.Time
	last    updateWindowDecision
	hasLast bool
}

var globalDeferredUpdates deferredUpdateTracker

// Decide runs the policy for latestVersion and maintains the deferral clock.
func (t *deferredUpdateTracker) Decide(now time.Time, latestVersion string, busy []updateBusyReason, ceiling time.Duration) updateWindowDecision {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.version != latestVersion {
		t.version = latestVersion
		t.since = time.Time{}
	}
	d := decideUpdateWindow(now, latestVersion, busy, t.since, ceiling)
	if d.Apply {
		// Applied (or forced): the clock has done its job. Clearing it means a
		// failed install that gets retried starts a fresh window rather than
		// re-forcing on every tick forever.
		t.version = ""
		t.since = time.Time{}
		t.last = d
		t.hasLast = true
		return d
	}
	if t.since.IsZero() {
		t.since = now
	}
	t.last = d
	t.hasLast = true
	return d
}

// Snapshot returns the most recent decision, for GET /agent/update to report
// WHY an available update has not installed. A producer with no consumer is
// not shipped: this is the consumer's half.
func (t *deferredUpdateTracker) Snapshot() (updateWindowDecision, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.last, t.hasLast
}

// Clear forgets any pending deferral. Called when an attended update runs, so
// the automatic path does not keep reporting a hold that no longer exists.
func (t *deferredUpdateTracker) Clear() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.version = ""
	t.since = time.Time{}
	t.last = updateWindowDecision{}
	t.hasLast = false
}
