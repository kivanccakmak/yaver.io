package main

// runner_auth_keepalive.go — the two consumers that make the refresh real.
//
// A signal with no consumer is not shipped (CLAUDE.md). runner_auth_refresh.go can
// renew a Codex credential; this file is what actually calls it, in the two places
// that matter:
//
//   1. codexCredentialKeepaliveLoop — the background heartbeat. Answers the holiday
//      case: the box is idle for a week, the 10-day token ages out unattended, and
//      nothing notices until the user's next prompt. Now the box renews itself while
//      nobody is watching.
//
//   2. ensureRunnerCredentialFreshForTurn — the pre-spawn hook. Answers the case the
//      user actually hit: the task finished, they typed a follow-up, and the runner
//      was signed out. Because Yaver spawns a fresh Codex process per turn, renewing
//      HERE is both the keep-alive and the workaround for openai/codex#17041 (a live
//      Codex session cannot pick up an externally refreshed credential — but a
//      process that has not started yet has nothing to pick up).
//
// THE UI LAW THIS FILE OBEYS. A refresh is a NON-EVENT. No spinner, no toast, no
// modal, no banner, no transcript line, no re-render — on any surface. The user asked
// for this in as many words ("while refreshing we should not kill ux ui etc pollute
// there"), and it is the same law CLAUDE.md already states as "no surprise re-render
// while the user is watching or typing". The only thing that may ever reach a screen
// is a genuinely unrecoverable re-auth, and even then it is one line and one button on
// the surface the user is already looking at. Everything in this file therefore
// returns a verdict and logs to the agent log; none of it emits an event, an
// incident, or a task line on the happy path.

import (
	"context"
	"log"
	"time"
)

// codexKeepaliveInterval is how often the box asks "is the credential inside its
// renewal window?".
//
// The check is nearly free — one stat, one read, one base64 decode of a file we
// already own; no fork, no network, no tokens. So the cadence is chosen for
// RESPONSIVENESS to the 24 h renewal window rather than to amortize a cost: 15 min
// means a box that wakes from sleep, or comes back on network, closes its gap almost
// immediately. Contrast the old 6 h runner-auth health probe, which forked a CLI that
// could not read expiry at all.
const codexKeepaliveInterval = 15 * time.Minute

// codexKeepaliveWarmup lets the agent finish booting (Convex pairing, device
// handshake, runner probes) before we add a network call to the queue.
const codexKeepaliveWarmup = 45 * time.Second

// codexCredentialKeepaliveLoop keeps this machine's Codex credential alive for as
// long as the agent runs.
func (s *HTTPServer) codexCredentialKeepaliveLoop(ctx context.Context) {
	select {
	case <-ctx.Done():
		return
	case <-time.After(codexKeepaliveWarmup + time.Duration(randInt63n(int64(90*time.Second)))):
		// Jittered so a fleet updated from one release does not synchronize its
		// token-endpoint calls.
	}

	tick := func() {
		res := refreshCodexCredentialIfNeeded(ctx, false)
		switch res.Outcome {
		case codexRefreshRenewed:
			// Already logged by the refresher, with the new expiry.
		case codexRefreshLineageLost:
			// The ONE outcome a human must resolve. Log it loudly here; the
			// surfaces pick it up through the normal runner-auth status path
			// (DetectRunnerRuntimeStatus), not through a push that would
			// interrupt whatever the user is doing.
			log.Printf("[codex-keepalive] cannot renew: %s", res.Reason)
			MarkRunnerAuthInvalidReason("codex", res.Reason)
		case codexRefreshFailed:
			// Transient. The credential on disk is untouched and still valid
			// until its own expiry, and we will try again next tick. Do NOT
			// mark the runner invalid for this — a flaky network is not a
			// signed-out runner, and saying so would be a false red.
			log.Printf("[codex-keepalive] renewal attempt failed (will retry): %s", res.Reason)
		}
	}

	tick()

	t := time.NewTicker(codexKeepaliveInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			tick()
		}
	}
}

// ensureRunnerCredentialFreshForTurn is the pre-spawn hook. Call it immediately before
// starting or resuming a turn.
//
// Contract, and it is deliberately narrow:
//   - It is SILENT on success. Returns a nil-ish healthy verdict and the caller
//     proceeds exactly as before. Nothing renders.
//   - It NEVER blocks the turn on a transient failure. If the network is down but the
//     credential has not expired yet, the turn goes ahead — the token is still good,
//     and refusing to run would be inventing an outage.
//   - It returns a non-healthy verdict ONLY when the credential genuinely cannot serve
//     this turn, so the caller can park the prompt instead of spending it on a spawn
//     that will 401.
//
// Runners other than codex are pass-through: this is the only one with a refresh
// lineage Yaver can drive today.
func ensureRunnerCredentialFreshForTurn(ctx context.Context, runnerID string) codexRefreshResult {
	if normalizeRunnerID(runnerID) != "codex" {
		return codexRefreshResult{Outcome: codexRefreshNotNeeded}
	}
	res := refreshCodexCredentialIfNeeded(ctx, false)

	// ABSENCE IS NOT EVIDENCE. `codexAuthPath()` resolves the AGENT's CODEX_HOME.
	// A box that runs tasks under a different tenant home (tenant_runtime.go sets
	// CODEX_HOME per guest) legitimately has no credential at the agent's path
	// while the task's runtime has a perfectly good one. Blocking the turn on that
	// would invent an outage — the exact "don't block a path we can't assess"
	// rule the preflight already states.
	//
	// So we park a turn ONLY on positive evidence from a credential we actually
	// found and read: a consumed/revoked lineage, a copy we must not renew, or a
	// truncated file. "No file here" falls through to the old behaviour and lets
	// the runner speak for itself.
	if res.Outcome == codexRefreshImpossible && res.Code == ReasonRunnerCodexNotAuthenticated {
		return codexRefreshResult{Outcome: codexRefreshNotNeeded}
	}
	if res.Outcome == codexRefreshFailed {
		// Transient. Decide from the credential itself, not from our failure to
		// reach the endpoint: if it has not expired, the turn is fine.
		if doc, err := readCodexCredentialDoc(codexAuthPath()); err == nil {
			if f := codexCredentialFreshnessOf(doc, time.Now()); f.Known && !f.Expired {
				log.Printf("[codex-keepalive] renewal failed but the credential is still %s — proceeding with the turn", f.describe(time.Now()))
				return codexRefreshResult{Outcome: codexRefreshNotNeeded, ExpiresAt: f.ExpiresAt}
			}
		}
	}
	return res
}
