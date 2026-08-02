package main

import (
	"strings"
	"testing"
	"time"
)

// The reaper's whole value is that it deletes stranded artifacts and NEVER
// deletes live ones. Both halves are asserted here, and the negative controls
// are the point: several cases fail loudly if a guard is removed, which is the
// only way to know a guard works (CLAUDE.md — "prove the guard by breaking it").

func cand(path string, mb int64, mod time.Time) diskGuardCandidate {
	return diskGuardCandidate{Path: path, Bytes: mb * 1024 * 1024, ModTime: mod}
}

// --- pressure tiers -------------------------------------------------------

func TestReaperCutoffTightensAsDiskFills(t *testing.T) {
	cases := []struct {
		used int
		want time.Duration
	}{
		{used: 100, want: 30 * time.Minute},
		{used: 95, want: 30 * time.Minute},
		{used: 94, want: 6 * time.Hour},
		{used: 90, want: 6 * time.Hour},
		{used: 89, want: 24 * time.Hour},
		{used: 80, want: 24 * time.Hour},
		{used: 79, want: 7 * 24 * time.Hour},
		{used: 0, want: 7 * 24 * time.Hour},
	}
	for _, c := range cases {
		got, why := reaperCutoff(c.used)
		if got != c.want {
			t.Errorf("reaperCutoff(%d) = %v, want %v", c.used, got, c.want)
		}
		if why == "" {
			t.Errorf("reaperCutoff(%d) returned no reason — a cutoff nobody can explain is the false green this file fixes", c.used)
		}
	}
}

// THE INCIDENT, as a test. On 2026-08-02 ubuntu-4gb sat at 100% used with
// 517 MB of /tmp/yaver-* dirs, and the on-demand scan reclaimed NOTHING because
// its cutoff was a fixed 7 days and every dir was hours old. A box that cannot
// start a browser must not be told to wait a week.
func TestReaperReclaimsAtFullDiskWhereTheFixedCutoffCouldNot(t *testing.T) {
	now := time.Now()
	// The three real leaked profiles, with their real sizes and ages.
	cands := map[string][]diskGuardCandidate{
		"yaver-tmp-dirs": {
			cand("/tmp/yaver-browser-window-2994939007", 133, now.Add(-4*time.Hour)),
			cand("/tmp/yaver-browser-window-766349734", 52, now.Add(-6*time.Hour)),
			cand("/tmp/yaver-browser-window-2368424859", 52, now.Add(-3*time.Hour)),
		},
	}

	// What the OLD fixed policy would have done: 7 days, so nothing.
	old, _ := reaperCutoff(0)
	for _, c := range cands["yaver-tmp-dirs"] {
		if now.Sub(c.ModTime) >= old {
			t.Fatalf("test premise broken: %s is older than the relaxed cutoff", c.Path)
		}
	}

	plan := buildReaperPlan(cands, 100, now, nil, nil)
	if plan.ReapBytes == 0 {
		t.Fatal("reaper freed nothing on a full disk — this is exactly the incident")
	}
	if got := plan.ReapBytes; got != 237*1024*1024 {
		t.Errorf("reapBytes = %d, want all three profiles (237 MB)", got)
	}
	for _, d := range plan.Decisions {
		if !d.Reap {
			t.Errorf("%s withheld at 100%% used: %s", d.Path, d.Reason)
		}
	}
}

// --- SAFETY 1: a registered live root is never taken ----------------------

func TestReaperNeverTakesARegisteredLiveRoot(t *testing.T) {
	now := time.Now()
	live := "/tmp/yaver-browser-window-live"
	cands := map[string][]diskGuardCandidate{
		// Ancient — far past every cutoff — but in use RIGHT NOW.
		"yaver-tmp-dirs": {cand(live, 500, now.Add(-30*24*time.Hour))},
	}
	protected := map[string]string{live: "browser lane (device ubuntu-4gb)"}

	// Maximum pressure: if anything could override the guard, this would.
	plan := buildReaperPlan(cands, 100, now, protected, nil)

	if plan.ReapBytes != 0 {
		t.Fatal("reaped a LIVE browser profile — disk pressure must never outrank liveness")
	}
	if len(plan.Decisions) != 1 || plan.Decisions[0].Reap {
		t.Fatal("live root was marked for reaping")
	}
	if !strings.Contains(plan.Decisions[0].Reason, "browser lane") {
		t.Errorf("reason %q does not name the owner — the report must say who holds it", plan.Decisions[0].Reason)
	}
	// NEGATIVE CONTROL: with the registration gone, the same artifact IS taken.
	// If this half stops holding, the guard above is passing for another reason.
	if p2 := buildReaperPlan(cands, 100, now, nil, nil); p2.ReapBytes == 0 {
		t.Fatal("negative control failed: unregistered 30-day-old artifact was not reaped, so the live-root test proves nothing")
	}
}

func TestReapProtectRegistersAndReleases(t *testing.T) {
	path := "/tmp/yaver-test-protect"
	if _, ok := reaperProtectedRoots()[path]; ok {
		t.Fatal("path already protected before the test began")
	}
	release := ReapProtect(path, "unit test")
	if owner := reaperProtectedRoots()[path]; owner != "unit test" {
		t.Fatalf("after ReapProtect owner = %q, want %q", owner, "unit test")
	}
	release()
	if _, ok := reaperProtectedRoots()[path]; ok {
		t.Fatal("release() did not unregister — a protection that never lifts turns a leak into a permanent one")
	}
}

// --- SAFETY 2: an active runner shadows anything it might own -------------

func TestReaperWithholdsArtifactsAnActiveRunnerMayOwn(t *testing.T) {
	now := time.Now()
	// A codex turn started 2 hours ago and is still running.
	active := []reaperRunnerActivity{{Runner: "codex", StartedAt: now.Add(-2 * time.Hour)}}

	cands := map[string][]diskGuardCandidate{
		"yaver-tmp-dirs": {
			// Touched DURING the live turn — must survive even at 100% used.
			cand("/tmp/yaver-scratch-during-turn", 200, now.Add(-90*time.Minute)),
			// Last touched before the turn began — safe to take.
			cand("/tmp/yaver-scratch-before-turn", 200, now.Add(-9*time.Hour)),
		},
	}

	plan := buildReaperPlan(cands, 100, now, nil, active)

	byPath := map[string]reaperDecision{}
	for _, d := range plan.Decisions {
		byPath[d.Path] = d
	}
	if byPath["/tmp/yaver-scratch-during-turn"].Reap {
		t.Fatal("reaped scratch modified during a LIVE codex turn — this is the user's 'beware of other runners' latest dates'")
	}
	if !strings.Contains(byPath["/tmp/yaver-scratch-during-turn"].Reason, "codex") {
		t.Errorf("reason %q must name the runner that shadows it", byPath["/tmp/yaver-scratch-during-turn"].Reason)
	}
	if !byPath["/tmp/yaver-scratch-before-turn"].Reap {
		t.Error("withheld scratch that predates every active turn — an over-broad guard reclaims nothing and the disk still fills")
	}

	// NEGATIVE CONTROL: with no runner active, the shadowed artifact is taken.
	if p2 := buildReaperPlan(cands, 100, now, nil, nil); p2.ReapBytes != 400*1024*1024 {
		t.Fatalf("negative control: with no active runner both should be reaped, got %s", p2.ReapHuman)
	}
}

// The floor is the OLDEST active start, not the newest: taking the newest would
// step on the longer-running turn, which is the expensive one to destroy.
func TestReaperRunnerFloorUsesTheOldestActiveSession(t *testing.T) {
	now := time.Now()
	active := []reaperRunnerActivity{
		{Runner: "claude", StartedAt: now.Add(-10 * time.Minute)},
		{Runner: "opencode", StartedAt: now.Add(-3 * time.Hour)},
		{Runner: "codex", StartedAt: time.Time{}}, // idle: contributes nothing
	}
	floor, who := reaperRunnerFloor(active)
	if who != "opencode" {
		t.Errorf("floor runner = %q, want opencode (the oldest active session)", who)
	}
	if d := now.Sub(floor); d < 2*time.Hour || d > 4*time.Hour {
		t.Errorf("floor is %v old, want ~3h", d)
	}
	if f, _ := reaperRunnerFloor(nil); !f.IsZero() {
		t.Error("no active runners must yield a zero floor, shadowing nothing")
	}
}

// --- SAFETY 3: unknown age is never guessed ------------------------------

func TestReaperRefusesToJudgeAnArtifactWithNoModTime(t *testing.T) {
	now := time.Now()
	cands := map[string][]diskGuardCandidate{
		"yaver-tmp-dirs": {{Path: "/tmp/yaver-unknown-age", Bytes: 999 * 1024 * 1024}},
	}
	plan := buildReaperPlan(cands, 100, now, nil, nil)
	if plan.ReapBytes != 0 {
		t.Fatal("reaped an artifact whose age is unknown — refusing is the only safe answer")
	}
	if !strings.Contains(plan.Decisions[0].Reason, "unknown") {
		t.Errorf("reason %q should say the age is unknown", plan.Decisions[0].Reason)
	}
}

// --- THE FALSE-GREEN FIX: a zero reclaim must still explain itself --------

// The incident's scan reported the yaver-tmp-dirs class as count=0, bytes=0,
// applicable=true while 517 MB of matching dirs sat in /tmp — all younger than
// its cutoff, which appeared nowhere. An operator read "nothing here" and went
// looking elsewhere on a disk with zero bytes free.
func TestReaperSummaryDistinguishesNothingFoundFromNothingReleased(t *testing.T) {
	now := time.Now()

	// Nothing at all.
	empty := buildReaperPlan(nil, 100, now, nil, nil)
	if !strings.Contains(empty.Summary, "no reclaimable artifacts") {
		t.Errorf("empty summary = %q", empty.Summary)
	}

	// 517 MB present, every byte withheld — the incident's true state.
	held := buildReaperPlan(map[string][]diskGuardCandidate{
		"yaver-tmp-dirs": {cand("/tmp/yaver-fresh", 517, now.Add(-5*time.Minute))},
	}, 100, now, nil, nil)

	if held.ReapBytes != 0 {
		t.Fatal("test premise: this artifact is younger than the 30m cutoff and must be held")
	}
	if held.Summary == empty.Summary {
		t.Fatal("'nothing found' and 'nothing released' produce the same sentence — that IS the false green")
	}
	for _, want := range []string{"517", "reclaimed none", "cutoff"} {
		if !strings.Contains(held.Summary, want) {
			t.Errorf("summary %q must contain %q: it has to name the bytes it is sitting on and the rule holding them", held.Summary, want)
		}
	}
	if held.HeldHuman == "" || held.HeldBytes == 0 {
		t.Error("withheld bytes are not reported — the report must account for what it did NOT take")
	}
}

// Every candidate gets a decision. A candidate that vanishes from the report is
// invisible, and invisible is how 517 MB hid on a full disk.
func TestReaperAccountsForEveryCandidate(t *testing.T) {
	now := time.Now()
	cands := map[string][]diskGuardCandidate{
		"yaver-tmp-dirs":  {cand("/tmp/yaver-a", 10, now.Add(-9*time.Hour)), cand("/tmp/yaver-b", 10, now)},
		"opencode-tmp-so": {cand("/tmp/.abc-00000000.so", 5, now.Add(-9*time.Hour))},
	}
	plan := buildReaperPlan(cands, 100, now, nil, nil)
	if len(plan.Decisions) != 3 {
		t.Fatalf("got %d decisions for 3 candidates — every one must be accounted for", len(plan.Decisions))
	}
	for _, d := range plan.Decisions {
		if d.Reason == "" {
			t.Errorf("%s has no reason", d.Path)
		}
		if d.Class == "" {
			t.Errorf("%s has no class", d.Path)
		}
	}
	if plan.ReapBytes+plan.HeldBytes != 25*1024*1024 {
		t.Error("reaped + held does not equal the candidate total — bytes went missing from the report")
	}
}

// Deterministic ordering: a report that reshuffles between passes cannot be
// diffed, and diffing consecutive passes is how a leak is spotted.
func TestReaperOutputIsDeterministic(t *testing.T) {
	now := time.Now()
	cands := map[string][]diskGuardCandidate{
		"zeta":  {cand("/tmp/yaver-z", 1, now.Add(-9*time.Hour))},
		"alpha": {cand("/tmp/yaver-a", 1, now.Add(-9*time.Hour))},
		"mid":   {cand("/tmp/yaver-m", 1, now.Add(-9*time.Hour))},
	}
	first := buildReaperPlan(cands, 100, now, nil, nil)
	for i := 0; i < 5; i++ {
		p := buildReaperPlan(cands, 100, now, nil, nil)
		for j := range p.Decisions {
			if p.Decisions[j].Path != first.Decisions[j].Path {
				t.Fatal("decision order varies between passes — map iteration is leaking into the report")
			}
		}
	}
	if first.Decisions[0].Class != "alpha" {
		t.Errorf("classes are not sorted: first is %q", first.Decisions[0].Class)
	}
}

func TestItoaPct(t *testing.T) {
	for in, want := range map[int]string{0: "0%", 5: "5%", 80: "80%", 100: "100%", -1: "unknown%"} {
		if got := itoaPct(in); got != want {
			t.Errorf("itoaPct(%d) = %q, want %q", in, got, want)
		}
	}
}
