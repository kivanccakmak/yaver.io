package main

import (
	"strings"
	"time"
)

// runner_auth_observe.go — turning what the runner ALREADY TELLS US into the
// auth verdict every surface renders.
//
// POSTMORTEM (2026-07-27, user's own box, agent 1.99.383). `/runner-auth/status`
// said claude was `authConfigured:true authVerified:true ready:true
// authSource:"claude.ai · max"`. The user opened the web dashboard's PTY, typed
// "helo", and Claude Code answered:
//
//	Please run /login · API Error: 401 OAuth access token has been revoked.
//
// Yaver did not need a new API call to know this. The runner said it, out loud,
// on a stream Yaver was already reading — and Yaver rendered a green chip over
// the top of it. Three separate reasons, all fixed here or nearby:
//
//  1. The classifier did not match the sentence. Every claude branch of
//     IsRunnerAuthFailureOutput required "not logged in"; Claude Code says
//     "Please run /login". See ClassifyRunnerAuthFailure.
//  2. Only the hard-FAILURE branch of the task lifecycle ran the classifier.
//     The turn above exits ZERO. See the call site in tasks.go.
//  3. Nothing ever recorded a POSITIVE. "Verified" was inferred from a local
//     store that cannot see a revocation. See MarkRunnerAuthProven.
//
// The rule this file encodes: the streams Yaver already receives — task output,
// the PTY, the browser-auth session log — are the cheapest and most truthful
// auth probe available, because they are the operation itself. Read them.

// ObserveRunnerAuthFromOutput classifies one runner-attributed chunk of output
// and updates the auth ledger. Safe to call on every terminal task, every PTY
// read, and any other runner-owned stream.
//
// status is the task's terminal status when known ("" for a live stream). It is
// used only to decide whether a NON-rejecting stream counts as proof: a
// completed turn with real content means the provider served a generation,
// which is the only evidence of a working credential that costs nothing.
func ObserveRunnerAuthFromOutput(runnerID, output, status string) {
	id := normalizeRunnerID(runnerID)
	if id == "" {
		return
	}
	if rejected, reason := ClassifyRunnerAuthFailureFor(id, output); rejected {
		MarkRunnerAuthInvalidReason(id, reason)
		return
	}
	// A rejection attributed to a DIFFERENT runner in this stream is still
	// worth recording (a claude task can shell out to codex), but it must not
	// be read as proof for the runner that owned the task.
	if other, reason := ClassifyRunnerAuthFailure(output); other != "" && other != id {
		MarkRunnerAuthInvalidReason(other, reason)
		return
	}
	if runnerTurnProvesAuth(output, status) {
		MarkRunnerAuthProven(id)
	}
}

// runnerTurnProvesAuth reports whether this output is evidence that the
// PROVIDER served a real generation.
//
// Deliberately conservative. A short or empty reply proves nothing: the runner
// can exit 0 with no output when the model silently refuses (the opencode /
// glm-4.7 case), and an auth-failure banner is itself "output". We require a
// terminal status that means success AND enough content that a model must have
// produced it.
func runnerTurnProvesAuth(output, status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case string(TaskStatusFinished), string(TaskStatusReview):
	default:
		return false
	}
	return len(strings.TrimSpace(output)) >= runnerAuthProofMinOutputBytes
}

// Roughly a sentence. Below this we are looking at a banner or a prompt echo,
// not a generation.
const runnerAuthProofMinOutputBytes = 40

// runnerAuthVerifiedAtMillis is when the PROVIDER last spoke about this
// runner's credential — a proof or a rejection — as epoch ms, or 0 if it never
// has within the TTLs.
//
// This is the field that keeps a Convex-persisted verdict honest. `checkedAt`
// says when the agent last LOOKED at local state; without a separate
// "when did the provider last answer", a row saying authVerified:true is
// indistinguishable at rest from one whose proof is eleven hours old.
func runnerAuthVerifiedAtMillis(runnerID string) int64 {
	id := normalizeRunnerID(runnerID)
	if id == "" {
		return 0
	}
	lastRunnerAuthFailure.Lock()
	mark, rejected := lastRunnerAuthFailure.at[id]
	lastRunnerAuthFailure.Unlock()
	if rejected && time.Since(mark.at) <= runnerAuthFailureTTL {
		return mark.at.UnixMilli()
	}
	lastRunnerAuthProof.Lock()
	at, proven := lastRunnerAuthProof.at[id]
	lastRunnerAuthProof.Unlock()
	if proven && time.Since(at) <= runnerAuthProofTTL {
		return at.UnixMilli()
	}
	return 0
}

// ---------------------------------------------------------------------------
// Sign-in start policy
// ---------------------------------------------------------------------------

// RunnerAuthStartTrigger says WHO asked for a sign-in session.
type RunnerAuthStartTrigger string

const (
	// RunnerAuthTriggerAuto — a machine decided: a launch gate's not-verified
	// branch, a chip in "needs attention", a health loop, a dispatch preflight,
	// a modal that starts a session merely because it opened.
	RunnerAuthTriggerAuto RunnerAuthStartTrigger = "auto"
	// RunnerAuthTriggerExplicit — the user tapped "Sign in".
	RunnerAuthTriggerExplicit RunnerAuthStartTrigger = "explicit"
	// RunnerAuthTriggerConfirmed — the user tapped "Sign in", was told the
	// runner already looks signed in, and chose to re-sign-in anyway (switching
	// accounts). This is the ONLY trigger allowed to reap a healthy session.
	RunnerAuthTriggerConfirmed RunnerAuthStartTrigger = "confirmed"
)

// RunnerAuthStartAction is the verdict.
type RunnerAuthStartAction string

const (
	// RunnerAuthStartNew — spawn a fresh browser-auth session.
	RunnerAuthStartNew RunnerAuthStartAction = "start"
	// RunnerAuthStartReuse — an equivalent session is already in flight; return
	// it instead of reaping and respawning.
	RunnerAuthStartReuse RunnerAuthStartAction = "reuse"
	// RunnerAuthStartNoop — do nothing, and SAY WHY.
	RunnerAuthStartNoop RunnerAuthStartAction = "noop"
)

// RunnerAuthStartDecision carries the verdict plus the sentence to render.
type RunnerAuthStartDecision struct {
	Action RunnerAuthStartAction `json:"action"`
	Reason string                `json:"reason"`
	// Reauthable is true when a no-op could become a start if the user
	// confirms — i.e. the surface should offer "Sign in with a different
	// account" rather than just refusing.
	Reauthable bool `json:"reauthable,omitempty"`
}

// RunnerAuthStartInput is the state the decision reads. Kept as plain data so
// the policy is pure and testable without an agent, a network, or a clock.
type RunnerAuthStartInput struct {
	Runner   string
	Trigger  RunnerAuthStartTrigger
	Status   RunnerRuntimeStatus
	InFlight bool
}

// DecideRunnerAuthStart answers "should this request spawn `claude auth login`
// / `codex login --device-auth`, reuse what is running, or refuse and explain?"
//
// WHY THIS EXISTS (2026-07-27, same session as the false-green incident and its
// exact mirror): the user was shown sign-in dialogs repeatedly for runners that
// were fine. Starting a browser-auth session is NOT harmless — the start path
// reaps the prior session for that runner, burns a PKCE flow, prints a URL the
// user did not need, and for claude can end up REPLACING a working credential.
// "Ask again just in case" is a destructive operation wearing a helpful face.
//
// So both directions are now guarded by the SAME honest status:
//   - never render green over a dead credential (the false green), and
//   - never reap a live credential to re-prove a question already answered
//     (the false red).
//
// The asymmetry is deliberate. An AUTOMATIC trigger may not touch a runner that
// is verified-by-operation, and may not touch one that is merely present-and-
// unrejected either — presence is a good enough reason to leave a working box
// alone, and the launch gate now opens a terminal with a sign-in affordance
// beside it instead of spawning a flow nobody asked for. An EXPLICIT tap on a
// healthy runner is answered, not obeyed: it returns a no-op that names the
// current sign-in and is marked Reauthable, so the surface can offer a
// confirmed second step. Only CONFIRMED reaps.
func DecideRunnerAuthStart(in RunnerAuthStartInput) RunnerAuthStartDecision {
	label := runnerCapabilityName(in.Runner)
	st := in.Status

	// A confirmed re-sign-in is the user overriding us on purpose. It outranks
	// everything, including an in-flight session — switching accounts is
	// exactly when you want the old flow reaped.
	if in.Trigger == RunnerAuthTriggerConfirmed {
		return RunnerAuthStartDecision{
			Action: RunnerAuthStartNew,
			Reason: "Re-signing in to " + label + " at your request.",
		}
	}

	// Idempotence beats everything else. Two surfaces (phone + web) asking at
	// the same moment must converge on ONE session; reaping and respawning
	// would leave the first surface watching a session that no longer exists.
	if in.InFlight {
		return RunnerAuthStartDecision{
			Action: RunnerAuthStartReuse,
			Reason: "A " + label + " sign-in is already in progress on this machine — showing that one.",
		}
	}

	// Verified by an actual operation. Nothing to fix.
	if st.AuthConfigured && st.AuthVerified {
		return RunnerAuthStartDecision{
			Action:     RunnerAuthStartNoop,
			Reason:     label + " is already signed in on this machine" + runnerAuthSourceSuffix(st) + " — confirmed by a successful run, so no sign-in is needed.",
			Reauthable: true,
		}
	}

	// Present but unproven. An automatic trigger must leave it alone: the
	// credential is probably fine, and the cost of being wrong (a login prompt
	// inside the runner's own TUI) is far smaller than the cost of reaping a
	// good session. An explicit tap gets the same answer, plus the offer.
	if st.AuthConfigured && st.AuthPresent {
		return RunnerAuthStartDecision{
			Action:     RunnerAuthStartNoop,
			Reason:     label + " reports it is already signed in on this machine" + runnerAuthSourceSuffix(st) + ". Nobody has exercised that credential yet, but signing in again would replace a credential that is probably working.",
			Reauthable: true,
		}
	}

	// Credential found only by looking at the filesystem. Weak, but still not
	// something a background loop should overwrite unasked.
	if st.AuthConfigured && in.Trigger == RunnerAuthTriggerAuto {
		return RunnerAuthStartDecision{
			Action:     RunnerAuthStartNoop,
			Reason:     "A " + label + " credential is present on this machine" + runnerAuthSourceSuffix(st) + " but unconfirmed. Not starting a sign-in automatically — tap Sign in if " + label + " asks you to.",
			Reauthable: true,
		}
	}

	reason := strings.TrimSpace(st.Error)
	if reason == "" {
		reason = strings.TrimSpace(st.Warning)
	}
	if reason == "" {
		reason = label + " is not signed in on this machine."
	}
	return RunnerAuthStartDecision{Action: RunnerAuthStartNew, Reason: reason}
}

func runnerAuthSourceSuffix(st RunnerRuntimeStatus) string {
	if src := strings.TrimSpace(st.AuthSource); src != "" {
		return " (" + src + ")"
	}
	return ""
}
