package main

// runner_preflight.go — proactive runner auth pre-flight.
//
// THE PROBLEM (the "codex expired" friction): today a runner's auth state is
// only discovered when a task FAILS — watchProcess pattern-matches a 401 in the
// output and flips AuthConfigured off AFTER the fact (runner_auth.go). For a
// voice command from a car that is the worst possible moment: the user asks for
// something, waits, and gets "it failed" because the runner's subscription token
// quietly expired.
//
// RunnerPreflight checks the runner BEFORE dispatch so the surface can say
// "your codex login expired — re-authenticate" up front, instead of launching a
// doomed task.
//
// CORRECTION (2026-08-02 audit). This header used to assert that Yaver "cannot
// silently refresh a subscription OAuth token (claude / codex tokens are
// re-auth-only)". For Codex that is FALSE, and the mistake was load-bearing: it is
// why the product only ever detected-and-reported a problem that was PREVENTABLE.
// codex-cli speaks a standard `grant_type=refresh_token` exchange, and a login can
// stay alive for months on rotation alone. The renewal now lives in
// runner_auth_refresh.go, driven by the keep-alive loop and the pre-spawn hook in
// runner_auth_keepalive.go.
//
// So "proactive" now means what it should have meant: RENEW silently first, and fall
// back to an actionable CTA only for the one case a machine genuinely cannot fix —
// a refresh lineage that is gone (see ReasonRunnerCodexRefreshLineageLost). Claude
// remains detect-and-report; it has no refresh lineage Yaver can drive today.

import "strings"

// RunnerPreflightResult is the verdict for one runner before dispatch.
type RunnerPreflightResult struct {
	Runner      string `json:"runner"`
	Fresh       bool   `json:"fresh"`                 // ready to dispatch
	NeedsReauth bool   `json:"needsReauth,omitempty"` // auth missing/rejected
	Reason      string `json:"reason,omitempty"`
	Action      string `json:"action,omitempty"` // the command/CTA that fixes it
	// Spoken is a short, TTS-friendly line for the voice surface.
	Spoken string `json:"spoken,omitempty"`
}

// RunnerPreflightByID checks a runner by id (a minimal RunnerConfig is enough —
// DetectRunnerRuntimeStatus only switches on the normalized id). An unknown/empty
// id is treated as fresh (the TaskManager resolves the default runner itself; we
// don't block a path we can't assess).
func RunnerPreflightByID(runnerID, workDir string) RunnerPreflightResult {
	id := normalizeRunnerID(runnerID)
	if id == "" || !runnerHasAuthModel(id) {
		// Unknown / no-auth runners have nothing to pre-flight — the TaskManager
		// handles them; we don't block a path we can't assess.
		return RunnerPreflightResult{Runner: id, Fresh: true}
	}
	status := DetectRunnerRuntimeStatus(RunnerConfig{RunnerID: id}, workDir)
	if status.AuthConfigured {
		return RunnerPreflightResult{Runner: id, Fresh: true}
	}
	reason := gatewayFirstNonEmpty(status.Warning, status.Error, "not signed in")
	action := runnerReauthCommand(id)
	return RunnerPreflightResult{
		Runner:      id,
		Fresh:       false,
		NeedsReauth: true,
		Reason:      reason,
		Action:      action,
		Spoken:      "Your " + id + " login has expired. Re-authenticate with " + action + " to continue.",
	}
}

// runnerHasAuthModel reports whether a runner authenticates (so a missing/expired
// credential is a real pre-flight failure). Runners without an auth model are not
// pre-flighted.
func runnerHasAuthModel(id string) bool {
	switch normalizeRunnerID(id) {
	case "codex", "claude", "opencode":
		return true
	}
	return false
}

// runnerReauthCommand returns the command that re-establishes a runner's auth.
func runnerReauthCommand(id string) string {
	switch normalizeRunnerID(id) {
	case "codex":
		// --device-auth, NOT bare `codex login`.
		//
		// The bare form opens a browser and waits on a localhost callback. The boxes
		// that actually hit this are remote and headless — a Hetzner VPS, a Pi, an
		// SSH-only server — where that flow cannot complete at all. Handing a user
		// on a phone a command that is structurally impossible on the machine it
		// names is a route-to-fix that routes into a wall. The device-code flow is
		// the one that works from any browser, and Yaver already knows it (it is in
		// the classifier and in detectCodexStatus's error text).
		return "codex login --device-auth"
	case "claude":
		return "claude setup-token"
	case "opencode":
		return "opencode auth login"
	default:
		return "yaver runner auth " + id
	}
}

// runnerPreflightSpoken renders the preflight result as a one-line TTS string,
// or "" when fresh (nothing to say).
func runnerPreflightSpoken(r RunnerPreflightResult) string {
	if r.Fresh {
		return ""
	}
	return strings.TrimSpace(r.Spoken)
}
