package main

import (
	"strings"
	"testing"
	"time"
)

// fakeWarden lets a test drive the custodian without wall-clock or real devices.
type fakeWarden struct {
	name     string
	every    time.Duration
	findings []CustodianFinding
	block    time.Duration
	panics   bool
	sweeps   int
}

func (f *fakeWarden) Name() string         { return f.name }
func (f *fakeWarden) Every() time.Duration { return f.every }
func (f *fakeWarden) Sweep(now time.Time) []CustodianFinding {
	f.sweeps++
	if f.panics {
		panic("warden exploded")
	}
	if f.block > 0 {
		time.Sleep(f.block)
	}
	return f.findings
}

func TestCustodianPublishesFindingsToSubscribers(t *testing.T) {
	c := NewCustodian()
	w := &fakeWarden{name: "test", every: time.Minute, findings: []CustodianFinding{
		{Subject: "pid 1 · :8081", Problem: "orphan holding a port", Action: "stopped it", Outcome: OutcomeFixed},
	}}
	c.Register(w)

	ch, cancel := c.Subscribe()
	defer cancel()

	c.SweepOne(w, time.Now())

	select {
	case f := <-ch:
		if f.Warden != "test" {
			t.Fatalf("warden name should be filled in by the custodian, got %q", f.Warden)
		}
		if f.At.IsZero() {
			t.Fatalf("finding must carry a timestamp — a feed without times cannot be read")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("finding never reached the subscriber — the UI would show a working machine with a silent janitor")
	}
}

func TestCustodianSnapshotFlagsNeverRunWardens(t *testing.T) {
	c := NewCustodian()
	ran := &fakeWarden{name: "ran", every: time.Minute}
	never := &fakeWarden{name: "never", every: time.Minute}
	c.Register(ran)
	c.Register(never)
	c.SweepOne(ran, time.Now())

	snap := c.Snapshot()
	byName := map[string]CustodianWardenState{}
	for _, w := range snap.Wardens {
		byName[w.Name] = w
	}
	if byName["ran"].NeverRun {
		t.Fatalf("swept warden reported as never-run")
	}
	if !byName["never"].NeverRun {
		t.Fatalf("a warden that has NEVER swept must say so — rendering it as healthy is the false green this layer exists to remove")
	}
}

func TestCustodianSnapshotIsNewestFirst(t *testing.T) {
	c := NewCustodian()
	w := &fakeWarden{name: "t", every: time.Minute}
	c.Register(w)
	base := time.Now()
	for i, subj := range []string{"first", "second", "third"} {
		w.findings = []CustodianFinding{{Subject: subj, Outcome: OutcomeFixed}}
		c.SweepOne(w, base.Add(time.Duration(i)*time.Second))
	}
	snap := c.Snapshot()
	if len(snap.Recent) != 3 || snap.Recent[0].Subject != "third" {
		t.Fatalf("expected newest-first feed, got %v", snap.Recent)
	}
}

// TestCustodianBoundsRunnerEscalation is the money guard: an unfixable failure
// must not become an all-night paid loop of runner calls.
func TestCustodianBoundsRunnerEscalation(t *testing.T) {
	c := NewCustodian()
	w := &fakeWarden{name: "flaky", every: time.Minute, findings: []CustodianFinding{
		{Subject: "gradle", Problem: "assembleDebug failed", Action: "escalating", Outcome: OutcomeNeedsRunner},
	}}
	c.Register(w)

	now := time.Now()
	var outcomes []CustodianOutcome
	for i := 0; i < 5; i++ {
		got := c.SweepOne(w, now.Add(time.Duration(i)*time.Second))
		outcomes = append(outcomes, got[0].Outcome)
	}

	runnerCalls := 0
	for _, o := range outcomes {
		if o == OutcomeNeedsRunner {
			runnerCalls++
		}
	}
	if runnerCalls != escalationsPerSignaturePerHour {
		t.Fatalf("same problem escalated %d times in an hour, cap is %d — a flapping failure would run an unbounded paid loop overnight",
			runnerCalls, escalationsPerSignaturePerHour)
	}
	if outcomes[len(outcomes)-1] != OutcomeNeedsHuman {
		t.Fatalf("over-budget findings must DOWNGRADE to needs-human, not vanish: still-broken must stay visible (got %s)", outcomes[len(outcomes)-1])
	}
}

// TestCustodianSurvivesAWardenPanic — one bad warden must not stop housekeeping,
// and must not disappear quietly either.
func TestCustodianSurvivesAWardenPanic(t *testing.T) {
	c := NewCustodian()
	boom := &fakeWarden{name: "boom", every: time.Minute, panics: true}
	c.Register(boom)

	got := c.SweepOne(boom, time.Now())
	if len(got) != 1 || got[0].Outcome != OutcomeNeedsRunner {
		t.Fatalf("a panicking warden must surface as a finding, got %+v", got)
	}
	if !strings.Contains(got[0].Problem, "panicked") {
		t.Fatalf("finding should name the panic, got %q", got[0].Problem)
	}
}

// TestCustodianAbandonsAHangingWarden — a warden blocked on a wedged `ps` or
// `simctl` must not hold the sweep forever. Abandon, never join.
func TestCustodianAbandonsAHangingWarden(t *testing.T) {
	c := NewCustodian()
	// Shorten the timeout for the test by using a warden that blocks longer than
	// the sweep budget is willing to wait.
	slow := &fakeWarden{name: "slow", every: time.Minute, block: custodianSweepTimeout + 5*time.Second}
	c.Register(slow)

	start := time.Now()
	got := c.SweepOne(slow, start)
	elapsed := time.Since(start)

	if elapsed >= custodianSweepTimeout+3*time.Second {
		t.Fatalf("sweep waited %s on a hung warden — it must abandon at %s", elapsed, custodianSweepTimeout)
	}
	if len(got) != 1 || got[0].Outcome != OutcomeNeedsHuman {
		t.Fatalf("an abandoned sweep must say the class is unchecked, got %+v", got)
	}
	if got[0].Remedy == "" {
		t.Fatalf("abandoned-sweep finding must name a next step, not just report")
	}
}

func TestSummariseSweepAlwaysSaysSomething(t *testing.T) {
	if got := summariseSweep(3, nil); !strings.Contains(got, "nothing needed fixing") {
		t.Fatalf("an empty sweep must be an ANSWER, not a blank panel: %q", got)
	}
	got := summariseSweep(3, []CustodianFinding{
		{Outcome: OutcomeFixed}, {Outcome: OutcomeNeedsHuman},
	})
	if !strings.Contains(got, "fixed 1") || !strings.Contains(got, "1 need you") {
		t.Fatalf("summary must count both lanes, got %q", got)
	}
}

// TestCustodianStartsWardensRegisteredAfterStart — found live on the Mac mini
// (2026-07-25): /custodian/status answered `wardens: null, sweeping: false` on a
// running agent, because the custodian was only wired inside a LAZY subsystem
// and any warden registered after Start was stored but never swept. A janitor
// that appears on the status page and nowhere else is worse than none: the page
// claims the class is covered.
func TestCustodianStartsWardensRegisteredAfterStart(t *testing.T) {
	c := NewCustodian()
	stop := make(chan struct{})
	defer close(stop)
	c.Start(stop)

	late := &fakeWarden{name: "late", every: 50 * time.Millisecond}
	c.Register(late) // arrives AFTER Start, like the runtime warden does

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if late.sweeps > 0 {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("a warden registered after Start never swept — it would show as watched while watching nothing")
}

// TestCustodianStartIsIdempotent — serve starts it and a lazy subsystem may call
// again; a second Start would double every sweep.
func TestCustodianStartIsIdempotent(t *testing.T) {
	c := NewCustodian()
	w := &fakeWarden{name: "w", every: 40 * time.Millisecond}
	c.Register(w)
	stop := make(chan struct{})
	defer close(stop)
	c.Start(stop)
	c.Start(stop)
	c.Start(stop)

	time.Sleep(300 * time.Millisecond)
	// Three tickers would give ~3x. Allow slack for scheduling, but not 2x.
	if w.sweeps > 12 {
		t.Fatalf("warden swept %d times in 300ms at a 40ms cadence — Start was not idempotent", w.sweeps)
	}
}
