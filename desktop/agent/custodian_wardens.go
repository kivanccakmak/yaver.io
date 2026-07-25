package main

// custodian_wardens.go — the wardens themselves, each one an existing reaper
// adapted rather than rewritten.
//
// The point of this file is that it is THIN. Every sweep here already existed as
// a bespoke goroutine with its own ticker and its own log prefix; all the
// custodian adds is one feed the user can actually see. If adapting a reaper
// required reimplementing it, the abstraction would be wrong.

import (
	"time"
)

// ── dev children (orphaned Metro / Vite / Next / Flutter holding a port) ─────

type devChildWarden struct{}

func (devChildWarden) Name() string { return "dev-children" }

// Every: orphans are created by an agent dying, so the startup sweep catches the
// common case. This cadence catches the rest — a child whose parent shell died
// mid-session, and a record whose process exited without the Wait goroutine
// running (kill -9 of the agent itself).
func (devChildWarden) Every() time.Duration { return 5 * time.Minute }

func (devChildWarden) Sweep(now time.Time) []CustodianFinding {
	return reapOrphanedDevChildren(now)
}

// ── WebRTC runtime sessions (abandoned, holding an exclusive simulator) ─────

type runtimeSessionWarden struct{ mgr *RemoteRuntimeManager }

func (runtimeSessionWarden) Name() string { return "runtime-sessions" }

// Every: matches the reaper cadence this replaces. Short, because a simulator
// held by a closed browser tab is the difference between "the machine is busy"
// and "the machine is lying".
func (runtimeSessionWarden) Every() time.Duration { return 30 * time.Second }

func (w runtimeSessionWarden) Sweep(now time.Time) []CustodianFinding {
	if w.mgr == nil {
		return nil
	}
	reaped := w.mgr.ReapAbandonedSessions(now)
	findings := make([]CustodianFinding, 0, len(reaped))
	for _, id := range reaped {
		findings = append(findings, CustodianFinding{
			Warden: "runtime-sessions", Subject: shortSessionID(id), Outcome: OutcomeFixed, At: now,
			Problem: "a streaming session had no viewer left but was still holding an exclusive device, " +
				"so the next request would be told the machine was full while it was idle",
			Action: "closed the abandoned session and released its device",
		})
	}
	return findings
}

// NOTE on exclusive claims: there is deliberately NO third warden for them.
// Claims are released by the two reapers above — the ones that own the lifecycle
// that took them. A separate claim-sweeper would race those reapers over the
// same resource and could free a claim mid-handshake, which is precisely what
// the runtime reaper's grace period exists to prevent. If a holding ever
// survives both, that is a bug in the owning reaper, not a job for a third
// mechanism.

// ── wiring ──────────────────────────────────────────────────────────────────

// agentCustodian is the process-wide custodian. One per agent: the findings feed
// is what the UI subscribes to, and two custodians would mean two half-feeds.
var agentCustodian = NewCustodian()

// StartAgentCustodian registers the machine-level wardens and starts sweeping.
// Called from serve BEFORE anything lazy: housekeeping that only begins once the
// user happens to open a WebRTC stream is housekeeping that never runs on the
// machines that need it most. (Observed exactly that on the Mac mini —
// /custodian/status answered `wardens: null, sweeping: false` on a healthy
// agent, because the only wiring lived inside ensureRemoteRuntimeManager.)
func StartAgentCustodian(stop <-chan struct{}) *Custodian {
	agentCustodian.Register(devChildWarden{})
	agentCustodian.Start(stop)
	return agentCustodian
}

// AttachRuntimeWarden adds the streaming-session sweep once its manager exists.
// Register starts a late warden immediately when the custodian is already
// running, so arriving after Start is not the same as never sweeping.
func AttachRuntimeWarden(mgr *RemoteRuntimeManager) {
	if mgr == nil {
		return
	}
	agentCustodian.Register(runtimeSessionWarden{mgr: mgr})
}

// ReportFailureToCustodian is the seam every failing operation calls instead of
// only returning an error. It consults the playbook (semi-deterministic lane)
// and publishes a finding, so a failure the user never sees in a log still
// reaches the surface they are looking at.
//
// Returns the playbook entry when one matched, so the caller can APPLY the verb.
// The custodian deliberately does not apply verbs itself: the code that owns the
// operation knows how to redo it, and a janitor reaching into arbitrary
// subsystems is how a self-healer becomes the outage.
func ReportFailureToCustodian(warden, subject, failureText string) (PlaybookEntry, bool) {
	finding, matched := PlaybookFinding(warden, subject, failureText)
	agentCustodian.record(finding)
	if !matched {
		return PlaybookEntry{}, false
	}
	entry, _ := MatchPlaybook(failureText)
	return entry, entry.AutoApply
}
