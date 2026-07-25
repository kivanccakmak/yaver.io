package main

// custodian.go — ONE housekeeping layer for every "the inventory says yes, the
// operation says no" drift on a machine, and it narrates itself to the user.
//
// ── Why this exists ──────────────────────────────────────────────────────────
//
// In a single day (2026-07-25) the same reaper got written three times:
//
//   remote_runtime_reaper.go     abandoned WebRTC sessions holding a simulator
//   devserver_child_registry.go  orphaned dev children holding a port
//   exclusive_claims.go          claims whose owner no longer exists
//
// Three bespoke loops, three tickers, three log prefixes — and all three
// INVISIBLE to the person using the product. The user's machine quietly looked
// full while it was idle, and the only place that said otherwise was a launchd
// stderr log on a Mac mini. A janitor nobody can see is indistinguishable from
// no janitor: when the phone says "every simulator is claimed", the user cannot
// tell whether the box is busy or lying.
//
// So this file is the generalization, and it has two jobs of equal weight:
//
//  1. SWEEP — evaluate real state on a cadence and fix what is unambiguously
//     fixable.
//  2. SAY SO — stream every inspection and action to whatever surface the user
//     is actually looking at (web / mobile / TV), because a wait or a
//     self-repair the user cannot see is itself a defect.
//
// ── The fast lane / slow lane split ──────────────────────────────────────────
//
// Wardens are DETERMINISTIC. They handle failure shapes with exactly one right
// answer, instantly and for free: a dead PID's port, a claim with no claimant, a
// session with no viewer. That is the fast lane, and it must stay in code — an
// LLM round-trip per port bind would cost seconds and quota on a solved problem.
//
// What a warden cannot classify becomes OutcomeNeedsRunner: a finding carrying
// structured Evidence (command, cwd, exit code, log tail, elapsed) for a coding
// runner to diagnose. That is the slow lane, and it is deliberately bounded —
// see escalationAllowed. A flapping dev server that escalates every 30s would
// otherwise run an unbounded paid loop overnight, which is a worse failure than
// the one it was trying to fix.
//
// ── The honesty rules a warden must obey ─────────────────────────────────────
//
//   • Probe the operation, never the proxy. "PID exists" is not "it is still our
//     process"; "cert present" is not "cert can sign".
//   • Spared is a first-class outcome. A warden that verified and decided NOT to
//     act must say so — silence there reads as "nothing was wrong", and the next
//     debugger re-derives the whole thing.
//   • Remedy text names the specific next step, never "check your configuration".

import (
	"fmt"
	"log"
	"sync"
	"time"
)

// CustodianOutcome is what actually happened to a finding. Deliberately not a
// bool: "I looked and chose not to touch it" is information the user needs.
type CustodianOutcome string

const (
	// OutcomeFixed — unambiguous and idempotent, already done.
	OutcomeFixed CustodianOutcome = "fixed"
	// OutcomeSpared — it looked wrong, verification said otherwise, left alone.
	OutcomeSpared CustodianOutcome = "spared"
	// OutcomeNeedsHuman — the remedy is known but not safe to apply unattended
	// (mutating account state, guessing a password, deleting user data).
	OutcomeNeedsHuman CustodianOutcome = "needs-human"
	// OutcomeNeedsRunner — no known remedy; hand the evidence to a coding runner.
	OutcomeNeedsRunner CustodianOutcome = "needs-runner"
)

// CustodianFinding is one sentence about one subject, plus what was done to it.
// Shaped so a UI can render it without interpretation and a runner can act on it
// without re-collecting context.
type CustodianFinding struct {
	Warden   string           `json:"warden"`
	Subject  string           `json:"subject"` // "pid 74050 · :19008"
	Problem  string           `json:"problem"` // what is wrong, in plain language
	Action   string           `json:"action"`  // what was done about it
	Outcome  CustodianOutcome `json:"outcome"`
	Remedy   string           `json:"remedy,omitempty"`   // for needs-human: the exact next step
	Evidence []string         `json:"evidence,omitempty"` // for needs-runner: command, exit, log tail
	At       time.Time        `json:"at"`
}

// Signature identifies a recurring problem so escalations can be deduped. Warden
// + subject + problem, not the timestamp — the same wedged port every 30s is ONE
// problem, not 120 an hour.
func (f CustodianFinding) Signature() string {
	return f.Warden + "|" + f.Subject + "|" + f.Problem
}

// Warden inspects one class of drift. Small on purpose: the value is in there
// being many of them, all reported through one channel the user can see.
type Warden interface {
	// Name is the stable identifier shown in the UI ("dev-children").
	Name() string
	// Every is this warden's sweep cadence.
	Every() time.Duration
	// Sweep evaluates real state and returns what it found AND did. Must be
	// safe to call concurrently with the rest of the agent, and must never
	// block indefinitely — a warden that hangs is a janitor that stops.
	Sweep(now time.Time) []CustodianFinding
}

const (
	// custodianHistoryMax bounds the ring buffer a late UI subscriber replays.
	custodianHistoryMax = 96
	// escalationsPerSignaturePerHour caps runner escalations for the SAME
	// problem. Without it, one unfixable failure becomes an all-night paid loop.
	escalationsPerSignaturePerHour = 2
	// custodianSweepTimeout bounds any single warden sweep. A warden that
	// exceeds it is reported as a finding — a janitor whose failures are silent
	// is the bug this file exists to remove.
	custodianSweepTimeout = 20 * time.Second
)

// Custodian runs wardens and publishes their findings.
type Custodian struct {
	mu      sync.RWMutex
	wardens []Warden
	history []CustodianFinding
	lastRun map[string]time.Time
	counts  map[CustodianOutcome]int

	subsMu sync.Mutex
	subs   map[int]chan CustodianFinding
	nextID int

	escMu sync.Mutex
	esc   map[string][]time.Time // signature -> escalation timestamps
}

// NewCustodian builds an empty custodian. Register wardens, then Start.
func NewCustodian() *Custodian {
	return &Custodian{
		lastRun: map[string]time.Time{},
		counts:  map[CustodianOutcome]int{},
		subs:    map[int]chan CustodianFinding{},
		esc:     map[string][]time.Time{},
	}
}

// Register adds a warden. Safe before or after Start.
func (c *Custodian) Register(w Warden) {
	if w == nil {
		return
	}
	c.mu.Lock()
	c.wardens = append(c.wardens, w)
	c.mu.Unlock()
}

// Start runs every registered warden on its own cadence until stop closes. Each
// warden gets its own goroutine so a slow one cannot delay the others — the
// alternative (one loop over all wardens) means a 20 s simulator probe stops the
// port janitor, which is how a janitor silently dies.
func (c *Custodian) Start(stop <-chan struct{}) {
	c.mu.RLock()
	wardens := append([]Warden(nil), c.wardens...)
	c.mu.RUnlock()

	for _, w := range wardens {
		go c.runWarden(w, stop)
	}
}

func (c *Custodian) runWarden(w Warden, stop <-chan struct{}) {
	every := w.Every()
	if every <= 0 {
		every = time.Minute
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case now := <-ticker.C:
			c.SweepOne(w, now)
		}
	}
}

// SweepOne runs a single warden and publishes what it found. Exported so a test
// (and an operator-triggered "sweep now" from the UI) can drive it without
// waiting on wall-clock.
func (c *Custodian) SweepOne(w Warden, now time.Time) []CustodianFinding {
	done := make(chan []CustodianFinding, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				// A panicking warden must not take the agent down, and must not
				// disappear quietly either.
				done <- []CustodianFinding{{
					Warden: w.Name(), Subject: "sweep", Outcome: OutcomeNeedsRunner,
					Problem: "this warden panicked mid-sweep, so its class of drift is going unchecked",
					Action:  "recovered and kept the other wardens running",
					Evidence: []string{
						"panic: " + fmt.Sprint(r),
					},
					At: now,
				}}
			}
		}()
		done <- w.Sweep(now)
	}()

	var findings []CustodianFinding
	select {
	case findings = <-done:
	case <-time.After(custodianSweepTimeout):
		// Abandon, never join: a warden blocked on a wedged `ps` or a hung
		// simctl would otherwise hold this goroutine forever. Same rule as the
		// bounded heartbeat probe.
		findings = []CustodianFinding{{
			Warden: w.Name(), Subject: "sweep", Outcome: OutcomeNeedsHuman,
			Problem: "sweep exceeded " + custodianSweepTimeout.String() + " and was abandoned — this class of drift is currently unchecked",
			Action:  "left the sweep running in the background and moved on",
			Remedy:  "check whether an underlying tool (ps / simctl / adb) is wedged on this machine",
			At:      now,
		}}
	}

	c.mu.Lock()
	c.lastRun[w.Name()] = now
	c.mu.Unlock()

	kept := make([]CustodianFinding, 0, len(findings))
	for _, f := range findings {
		if f.Warden == "" {
			f.Warden = w.Name()
		}
		if f.At.IsZero() {
			f.At = now
		}
		if f.Outcome == OutcomeNeedsRunner && !c.escalationAllowed(f, now) {
			// Over budget for this exact problem. Downgrade rather than drop —
			// the user still needs to know it is still broken.
			f.Outcome = OutcomeNeedsHuman
			f.Action = "not escalated again this hour (already tried twice) — still unresolved"
		}
		c.record(f)
		kept = append(kept, f)
	}
	return kept
}

// escalationAllowed rate-limits runner escalation per problem signature.
func (c *Custodian) escalationAllowed(f CustodianFinding, now time.Time) bool {
	sig := f.Signature()
	cutoff := now.Add(-time.Hour)
	c.escMu.Lock()
	defer c.escMu.Unlock()
	kept := make([]time.Time, 0, len(c.esc[sig]))
	for _, t := range c.esc[sig] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= escalationsPerSignaturePerHour {
		c.esc[sig] = kept
		return false
	}
	c.esc[sig] = append(kept, now)
	return true
}

func (c *Custodian) record(f CustodianFinding) {
	c.mu.Lock()
	c.history = append(c.history, f)
	if len(c.history) > custodianHistoryMax {
		c.history = c.history[len(c.history)-custodianHistoryMax:]
	}
	c.counts[f.Outcome]++
	c.mu.Unlock()

	// One log line per finding, in the same words the UI shows. When the two
	// disagree, one of them is lying to somebody.
	log.Printf("[custodian:%s] %s — %s · %s (%s)", f.Warden, f.Subject, f.Problem, f.Action, f.Outcome)

	c.subsMu.Lock()
	for id, ch := range c.subs {
		select {
		case ch <- f:
		default:
			// A stalled subscriber must never wedge housekeeping. Drop it: a UI
			// that stopped reading is a UI that went away.
			close(ch)
			delete(c.subs, id)
		}
	}
	c.subsMu.Unlock()
}

// CustodianReport is the snapshot every surface renders.
type CustodianReport struct {
	Wardens  []CustodianWardenState `json:"wardens"`
	Recent   []CustodianFinding     `json:"recent"`
	Counts   map[string]int         `json:"counts"`
	Sweeping bool                   `json:"sweeping"`
}

// CustodianWardenState answers "is this class of drift actually being watched?"
// — including the case where a warden has never run, which is the one a status
// page must never render as healthy.
type CustodianWardenState struct {
	Name      string `json:"name"`
	EverySec  int    `json:"everySec"`
	LastSwept string `json:"lastSwept,omitempty"`
	NeverRun  bool   `json:"neverRun"`
}

// Snapshot returns the current state for /custodian/status.
func (c *Custodian) Snapshot() CustodianReport {
	c.mu.RLock()
	defer c.mu.RUnlock()
	rep := CustodianReport{
		Counts:   map[string]int{},
		Sweeping: len(c.wardens) > 0,
		Recent:   append([]CustodianFinding(nil), c.history...),
	}
	for _, w := range c.wardens {
		st := CustodianWardenState{Name: w.Name(), EverySec: int(w.Every() / time.Second)}
		if t, ok := c.lastRun[w.Name()]; ok {
			st.LastSwept = t.UTC().Format(time.RFC3339)
		} else {
			st.NeverRun = true
		}
		rep.Wardens = append(rep.Wardens, st)
	}
	for k, v := range c.counts {
		rep.Counts[string(k)] = v
	}
	// Newest first: a housekeeping feed is read from the top.
	for i, j := 0, len(rep.Recent)-1; i < j; i, j = i+1, j-1 {
		rep.Recent[i], rep.Recent[j] = rep.Recent[j], rep.Recent[i]
	}
	return rep
}

// Subscribe returns a channel of live findings plus a cancel func. Buffered so a
// burst of findings during one sweep cannot block the sweep.
func (c *Custodian) Subscribe() (<-chan CustodianFinding, func()) {
	ch := make(chan CustodianFinding, 32)
	c.subsMu.Lock()
	id := c.nextID
	c.nextID++
	c.subs[id] = ch
	c.subsMu.Unlock()
	return ch, func() {
		c.subsMu.Lock()
		if existing, ok := c.subs[id]; ok {
			delete(c.subs, id)
			close(existing)
		}
		c.subsMu.Unlock()
	}
}
