package main

// runner_fallback.go — which runner ON THIS BOX can actually attempt a fix.
//
// ── The case this exists for ───────────────────────────────────────────────
//
// Read from the owner's live fleet, 2026-08-02:
//
//	magara   claude   ready   authSource "claude.ai · max"
//	         codex    NOT ready — no credentials found at all
//	         opencode ready   authSource "GLM API key"
//	ubuntu   claude   ready   "claude.ai · max"
//	         codex    ready   "codex login status"   <- token actually dead
//	         opencode ready   "GLM API key"
//
// When Codex's OAuth died on ubuntu, "Fix with Codex" dispatched Codex, which
// failed for the same reason, which offered the button again. Meanwhile
// OpenCode sat there ready, backed by a GLM API key — a credential with NO
// OAuth to expire, so it is structurally incapable of the failure that just
// happened. Not merely "another option": immune to this specific fault.
//
// And readiness is PER BOX. Codex is fine on ubuntu and has no credentials at
// all on magara, so a fallback chosen anywhere but on the target machine can
// route a fix to a runner that cannot start.
//
// The web mirror is web/lib/runnerFallback.ts. This copy exists because the
// AGENT must be able to answer the question too — for voice, for MCP, and for
// any surface that has no dashboard in front of it.

import "strings"

// RunnerAuthMechanism is how a runner proves itself to its provider.
type RunnerAuthMechanism string

const (
	// RunnerAuthAPIKey — an API key (z.ai / GLM, OpenRouter, an env provider).
	// No OAuth grant exists, so token_expired / refresh_token_reused / revoked
	// are all impossible for it.
	RunnerAuthAPIKey RunnerAuthMechanism = "api-key"
	// RunnerAuthSubscription — a consumer OAuth grant (claude.ai, ChatGPT).
	// Expires, is revocable server-side, and can look healthy locally while
	// already dead — which is exactly what ubuntu's codex row did.
	RunnerAuthSubscription RunnerAuthMechanism = "subscription-oauth"
	// RunnerAuthUnknown — nothing reported. Never guessed into the others.
	RunnerAuthUnknown RunnerAuthMechanism = "unknown"
)

// DetectRunnerAuthMechanism infers the mechanism from the agent's own
// authSource label.
//
// Conservative on purpose: an unrecognised label stays unknown. Mislabelling a
// subscription runner as api-key would make us recommend it precisely when
// OAuth is the thing that broke.
func DetectRunnerAuthMechanism(authSource string) RunnerAuthMechanism {
	s := strings.ToLower(strings.TrimSpace(authSource))
	if s == "" {
		return RunnerAuthUnknown
	}
	if strings.Contains(s, "api key") || strings.Contains(s, "api-key") ||
		strings.Contains(s, "apikey") || strings.Contains(s, "env") {
		return RunnerAuthAPIKey
	}
	if strings.Contains(s, "opencode") && strings.Contains(s, "auth.json") {
		return RunnerAuthAPIKey
	}
	if strings.Contains(s, "claude.ai") || strings.Contains(s, "chatgpt") ||
		strings.Contains(s, "login status") || strings.Contains(s, "oauth") ||
		strings.Contains(s, "subscription") {
		return RunnerAuthSubscription
	}
	return RunnerAuthUnknown
}

// RunnerFixCandidate is the agent's answer to "who should attempt this fix".
type RunnerFixCandidate struct {
	Runner string `json:"runner"`
	// Why is checkable prose — it names the mechanism so a user can verify it
	// against what the box reports rather than trusting a ranking.
	Why string `json:"why"`
	// Immune is true only when the candidate CANNOT have the failure mode that
	// just occurred, not merely when it is a different runner.
	Immune bool `json:"immune"`
	// Mechanism is carried so surfaces can explain the choice consistently.
	Mechanism RunnerAuthMechanism `json:"mechanism"`
}

// accountBoundFailure reports whether the failure belongs to the failing
// runner's ACCOUNT — in which case re-running the same runner cannot help.
func accountBoundFailure(kind string) bool {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "auth", "auth-revoked", "model-not-supported", "billing":
		return true
	}
	return false
}

// PlanRunnerFix picks the runner on this machine to attempt a fix with.
//
// Returns nil when nothing here can help — deliberately, so a caller renders a
// route (Remote OAuth, install a runner) instead of a button it cannot honour.
func PlanRunnerFix(failedRunner, failureKind string, runners []RunnerStatusRow) *RunnerFixCandidate {
	failed := normalizeRunnerID(failedRunner)
	bound := accountBoundFailure(failureKind)

	best := (*RunnerFixCandidate)(nil)
	bestScore := -1
	for _, r := range runners {
		id := normalizeRunnerID(r.RunnerID)
		if id == "" || !r.Installed || !r.Ready {
			continue
		}
		// An explicit "no usable credential" from the box is authoritative.
		if r.AuthConfigured != nil && !*r.AuthConfigured {
			continue
		}
		// Never re-offer the runner whose own account just refused the work.
		if bound && id == failed {
			continue
		}

		mech := DetectRunnerAuthMechanism(r.AuthSource)
		score := 0
		why := ""
		immune := false
		if bound && mech == RunnerAuthAPIKey {
			score += 100
			immune = true
			src := r.AuthSource
			if src == "" {
				src = "an API key"
			}
			why = runnerLabelOrDefault(id) + " on this machine authenticates with " + src +
				", so it cannot hit the account problem that just stopped " + runnerLabelOrDefault(failed) + "."
		} else if mech == RunnerAuthAPIKey {
			score += 20
			why = runnerLabelOrDefault(id) + " is ready here and uses an API key, which has no sign-in to expire."
		}
		if r.AuthVerified != nil && *r.AuthVerified {
			score += 40
			if why == "" {
				why = runnerLabelOrDefault(id) + "'s credential has actually been exercised successfully on this machine."
			}
		} else if r.AuthPresent != nil && *r.AuthPresent {
			score += 10
		}
		if why == "" {
			why = runnerLabelOrDefault(id) + " is installed and ready on this machine."
		}
		if score > bestScore {
			bestScore = score
			best = &RunnerFixCandidate{Runner: id, Why: why, Immune: immune, Mechanism: mech}
		}
	}
	return best
}

// RunnerStatusRow is the minimal shape PlanRunnerFix needs. Pointers so
// "not reported" stays distinguishable from "reported false" — the whole
// AuthPresent/AuthVerified split depends on that difference.
type RunnerStatusRow struct {
	RunnerID       string
	Installed      bool
	Ready          bool
	AuthConfigured *bool
	AuthPresent    *bool
	AuthVerified   *bool
	AuthSource     string
}

// runnerLabelOrDefault reuses the existing runnerDisplayName
// (monorepo_start_runners.go) and adds only what it lacks here: normalization
// and a sentence-safe fallback when the failing runner is unknown. A second
// copy of the name table is exactly the drift this file's parity guards exist
// to prevent.
func runnerLabelOrDefault(id string) string {
	n := normalizeRunnerID(id)
	if n == "" {
		return "the runner"
	}
	return runnerDisplayName(n)
}
