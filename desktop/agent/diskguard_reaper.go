package main

// PERIODIC ARTIFACT REAPER — the agent watches its own leavings.
//
// THE INCIDENT THIS EXISTS FOR (2026-08-02, ubuntu-4gb-hel1-1).
// The browser lane failed with:
//
//	chrome failed to start: cannot create temporary directory for the root
//	file system: No such file or directory
//
// The box was at 75G/75G — **0 bytes free**. And 237 MB of that was Yaver's
// OWN leaked Chrome profiles: /tmp/yaver-browser-window-* from three earlier
// runs, 133M + 52M + 52M. The lane creates one per launch and removes it on a
// clean stop — but a crash, a kill, or an agent restart strands it forever, so
// the operation that fails is the *next* run of the very thing that leaked.
//
// Three separate false greens stacked on top of each other:
//
//  1. Nothing ever looked. Cleanup existed only on the clean-stop path, which
//     is exactly the path a crash does not take. The leak was unbounded.
//  2. `diskguard_scan` reported the `yaver-tmp-dirs` class as
//     count=0, bytes=0, applicable=true — while 517 MB of matching dirs sat in
//     /tmp. They were all younger than its fixed 7-day cutoff. "Nothing to
//     reclaim" on a disk with zero bytes free is not a safe answer, it is a
//     silent one: the cutoff was reported nowhere, so the operator saw an empty
//     class and concluded the disk was full of something else.
//  3. The failure never mentioned disk. Chrome's message names a temp
//     directory; Yaver's remedy string blamed the dev server's port. The user
//     was routed to check /dev/status on a box whose real problem was that
//     nothing could write a byte anywhere.
//
// So this file adds the missing layer: a bounded, periodic pass that finds
// STRANDED artifacts and removes them, with two hard safety properties.
//
// SAFETY PROPERTY 1 — PRESSURE SCALES THE CUTOFF, LIVENESS NEVER RELAXES.
// A fixed 7-day age is right at 40% full and absurd at 100%: "wait a week" is
// not a policy when the next operation cannot start. reaperCutoff tightens the
// age as the disk fills. What it does NOT do is weaken the liveness checks —
// those are absolute at every pressure. Disk pressure may never become a reason
// to delete something in use.
//
// SAFETY PROPERTY 2 — LIVE THINGS ARE ASKED, NOT GUESSED.
// mtime cannot tell "a dead run left this" from "a live run is between writes".
// A runner mid-turn can leave a tree untouched for minutes while it thinks. So
// this reaper does not infer liveness:
//
//   - subsystems REGISTER the roots they own while alive (the browser pool, dev
//     servers, preview builds) via ReapProtect, and a registered path is never
//     a candidate, at any age, at any pressure;
//   - any ACTIVE runner session (claude, codex, opencode) publishes when it
//     started, and nothing modified since the OLDEST such start is eligible —
//     that is the user's "beware of other runners' latest date things". An
//     in-flight run's scratch is protected even when the reaper has no idea
//     which directory belongs to it.
//
// The decision for every candidate is recorded with a REASON, kept or dropped,
// so the answer is never a bare zero. That is the actual fix for false green
// number 2 — reporting the withholding, not just the reclaim.
//
// Prove it by breaking it: reaper_test.go asserts a registered root and a
// runner-shadowed artifact both survive at 100% used. Delete either guard and
// those cases fail.

import (
	"sort"
	"sync"
	"time"
)

// reaperInterval is how often the agent looks. Deliberately slow: this is
// advisory housekeeping and must never sit in the critical path of real work,
// so a missed pass costs nothing and a frequent pass buys nothing.
const reaperInterval = 30 * time.Minute

// reaperPressureTier maps disk usage to the age an artifact must reach before
// it is eligible. Tiers rather than a curve so the behaviour is stateable in
// one sentence per band and testable at the boundaries.
type reaperPressureTier struct {
	AtLeastUsedPercent int
	MinAge             time.Duration
	Note               string
}

// reaperTiers are consulted high-to-low; the first match wins.
//
// The 95% band is the incident band. Below 80% nothing is urgent and the
// week-long cutoff of the on-demand scan is exactly right; a box that will
// refuse the next operation is a different situation and gets a different
// answer.
var reaperTiers = []reaperPressureTier{
	{AtLeastUsedPercent: 95, MinAge: 30 * time.Minute, Note: "disk is nearly full — the next operation will fail"},
	{AtLeastUsedPercent: 90, MinAge: 6 * time.Hour, Note: "disk is filling"},
	{AtLeastUsedPercent: 80, MinAge: 24 * time.Hour, Note: "disk is over the comfort threshold"},
	{AtLeastUsedPercent: 0, MinAge: 7 * 24 * time.Hour, Note: "disk is healthy — only long-stranded artifacts qualify"},
}

// reaperCutoff returns the minimum age an artifact must have, plus the reason
// that band applies. Both are reported: an operator who sees "0 reclaimed"
// must be able to read WHY without guessing at a constant.
func reaperCutoff(usedPercent int) (time.Duration, string) {
	for _, t := range reaperTiers {
		if usedPercent >= t.AtLeastUsedPercent {
			return t.MinAge, t.Note
		}
	}
	// Unreachable while the table ends at 0, but a table edit must not
	// silently produce a zero cutoff that deletes everything.
	return 7 * 24 * time.Hour, "no tier matched — falling back to the safest cutoff"
}

// --- live-path registry ---------------------------------------------------

// reaperRegistry records paths that a live subsystem owns. A registered path is
// never eligible, regardless of age or pressure.
//
// This is the "probe the operation, never the inventory" rule applied to disk:
// rather than inferring from mtime whether a directory is in use, the code that
// created it says so, and says when it is done.
type reaperRegistry struct {
	mu    sync.RWMutex
	roots map[string]string // path -> owner label, for the report
}

var liveRoots = &reaperRegistry{roots: map[string]string{}}

// ReapProtect marks a path as owned by a live operation. The returned function
// releases it and must be deferred at the creation site — a protection that is
// never released turns a leak into a permanent one, which is worse than the
// bug this file fixes.
func ReapProtect(path, owner string) func() {
	if path == "" {
		return func() {}
	}
	liveRoots.mu.Lock()
	liveRoots.roots[path] = owner
	liveRoots.mu.Unlock()
	return func() {
		liveRoots.mu.Lock()
		delete(liveRoots.roots, path)
		liveRoots.mu.Unlock()
	}
}

// reaperProtectedRoots snapshots the live set for one pass.
func reaperProtectedRoots() map[string]string {
	liveRoots.mu.RLock()
	defer liveRoots.mu.RUnlock()
	out := make(map[string]string, len(liveRoots.roots))
	for k, v := range liveRoots.roots {
		out[k] = v
	}
	return out
}

// --- runner awareness -----------------------------------------------------

// reaperRunnerActivity is one active runner session as the reaper needs to see
// it: who, and since when.
type reaperRunnerActivity struct {
	Runner    string
	StartedAt time.Time
}

// reaperRunnerFloor is the OLDEST start time among active runner sessions, and
// the label of the runner it belongs to. Anything modified at or after that
// instant may belong to an in-flight run and is withheld.
//
// The oldest — not the newest — on purpose. Two runners active for 10 minutes
// and 2 hours means the safe boundary is 2 hours ago: taking the newest would
// step on the longer run's scratch, and the longer run is exactly the expensive
// one to destroy.
//
// A zero time means no runner is active and nothing is shadowed.
func reaperRunnerFloor(active []reaperRunnerActivity) (time.Time, string) {
	var floor time.Time
	var who string
	for _, a := range active {
		if a.StartedAt.IsZero() {
			continue
		}
		if floor.IsZero() || a.StartedAt.Before(floor) {
			floor, who = a.StartedAt, a.Runner
		}
	}
	return floor, who
}

// --- the decision ---------------------------------------------------------

// reaperDecision is one candidate's fate WITH its reason. Every candidate gets
// one, kept or dropped: the report says what was withheld and why, so a pass
// that frees nothing on a full disk still explains itself.
type reaperDecision struct {
	Path    string `json:"path"`
	Bytes   int64  `json:"bytes"`
	Human   string `json:"human"`
	Reap    bool   `json:"reap"`
	Reason  string `json:"reason"`
	Class   string `json:"class,omitempty"`
	AgeSecs int64  `json:"ageSeconds"`
}

// reaperJudge decides one candidate. Order matters and is the safety argument:
// the two liveness checks run BEFORE the age check, so no pressure tier can
// reach past them. An edit that moves the age check first would let a 100%-full
// disk delete a live browser profile — which is the original bug, restored.
func reaperJudge(
	cand diskGuardCandidate,
	class string,
	now time.Time,
	cutoff time.Duration,
	protected map[string]string,
	runnerFloor time.Time,
	runnerName string,
) reaperDecision {
	d := reaperDecision{
		Path:  cand.Path,
		Bytes: cand.Bytes,
		Human: humanBytesDG(cand.Bytes),
		Class: class,
	}
	if !cand.ModTime.IsZero() {
		d.AgeSecs = int64(now.Sub(cand.ModTime) / time.Second)
	}

	// 1. Owned by something alive. Absolute, at every pressure.
	if owner, ok := protected[cand.Path]; ok {
		d.Reason = "in use by " + owner + " — a live subsystem registered this path"
		return d
	}

	// 2. Shadowed by an active runner turn. Also absolute.
	if !runnerFloor.IsZero() && !cand.ModTime.Before(runnerFloor) {
		d.Reason = "modified after the " + runnerName + " session now running started — it may belong to that turn"
		return d
	}

	// 3. Too young for the current pressure band.
	if cand.ModTime.IsZero() {
		d.Reason = "no modification time — refusing to judge an artifact whose age is unknown"
		return d
	}
	if now.Sub(cand.ModTime) < cutoff {
		d.Reason = "younger than the " + cutoff.String() + " cutoff for this disk pressure"
		return d
	}

	d.Reap = true
	d.Reason = "stranded: no live owner, no runner active since it changed, older than " + cutoff.String()
	return d
}

// reaperPlan is one pass's full answer.
type reaperPlan struct {
	UsedPercent int              `json:"usedPercent"`
	Cutoff      string           `json:"cutoff"`
	CutoffWhy   string           `json:"cutoffWhy"`
	RunnerFloor string           `json:"runnerFloor,omitempty"`
	Decisions   []reaperDecision `json:"decisions"`
	ReapBytes   int64            `json:"reapBytes"`
	ReapHuman   string           `json:"reapHuman"`
	HeldBytes   int64            `json:"heldBytes"`
	HeldHuman   string           `json:"heldHuman"`
	// Summary is one honest sentence for a UI that has room for one line.
	Summary string `json:"summary"`
}

// buildReaperPlan is the whole policy as a pure function, so the logic that
// SHIPS is the logic that is TESTED — no filesystem, no clock, no globals.
func buildReaperPlan(
	candidates map[string][]diskGuardCandidate,
	usedPercent int,
	now time.Time,
	protected map[string]string,
	active []reaperRunnerActivity,
) reaperPlan {
	cutoff, why := reaperCutoff(usedPercent)
	floor, who := reaperRunnerFloor(active)

	plan := reaperPlan{UsedPercent: usedPercent, Cutoff: cutoff.String(), CutoffWhy: why}
	if !floor.IsZero() {
		plan.RunnerFloor = floor.UTC().Format(time.RFC3339) + " (" + who + ")"
	}

	classes := make([]string, 0, len(candidates))
	for c := range candidates {
		classes = append(classes, c)
	}
	sort.Strings(classes) // deterministic output; a report that reorders between passes is unreadable

	for _, class := range classes {
		for _, cand := range candidates[class] {
			d := reaperJudge(cand, class, now, cutoff, protected, floor, who)
			if d.Reap {
				plan.ReapBytes += d.Bytes
			} else {
				plan.HeldBytes += d.Bytes
			}
			plan.Decisions = append(plan.Decisions, d)
		}
	}
	plan.ReapHuman = humanBytesDG(plan.ReapBytes)
	plan.HeldHuman = humanBytesDG(plan.HeldBytes)
	plan.Summary = reaperSummary(plan)
	return plan
}

// reaperSummary states the outcome so that "nothing was freed" can never be
// mistaken for "there is nothing here". THIS is the fix for the false green:
// the incident's scan said 0 B and stopped, when the truthful answer was
// "517 MB present, all of it withheld, here is the rule that withheld it".
func reaperSummary(p reaperPlan) string {
	switch {
	case p.ReapBytes == 0 && p.HeldBytes == 0:
		return "no reclaimable artifacts found at " + itoaPct(p.UsedPercent) + " used"
	case p.ReapBytes == 0:
		return "found " + p.HeldHuman + " of artifacts but reclaimed none at " +
			itoaPct(p.UsedPercent) + " used — every one is in use or younger than the " +
			p.Cutoff + " cutoff (" + p.CutoffWhy + ")"
	case p.HeldBytes == 0:
		return "reclaiming " + p.ReapHuman + " of stranded artifacts at " + itoaPct(p.UsedPercent) + " used"
	default:
		return "reclaiming " + p.ReapHuman + " of stranded artifacts and holding " +
			p.HeldHuman + " still in use or too recent, at " + itoaPct(p.UsedPercent) + " used"
	}
}

func itoaPct(p int) string {
	if p < 0 {
		return "unknown%"
	}
	digits := ""
	if p == 0 {
		digits = "0"
	}
	for n := p; n > 0; n /= 10 {
		digits = string(rune('0'+n%10)) + digits
	}
	return digits + "%"
}
