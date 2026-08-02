package main

import (
	"strings"
	"time"
)

func diagnoseTaskFailure(task *Task, detectedAt time.Time) *TaskFailureDiagnosis {
	if task == nil || task.Status != TaskStatusFailed {
		return nil
	}
	text := strings.TrimSpace(task.Output + "\n" + task.ResultText)
	if text == "" {
		return &TaskFailureDiagnosis{
			Kind:       "runner_subprocess",
			Code:       "runner.subprocess.no_output",
			Title:      "Runner failed without output",
			Reason:     "The runner process ended in a failed state but did not leave a diagnostic message.",
			Remedy:     "Open the task details, run the selected runner Test action, then retry after the runner reports a real generation succeeds.",
			RunnerID:   normalizeRunnerID(task.RunnerID),
			Model:      strings.TrimSpace(task.Model),
			Probe:      "subprocess",
			DetectedAt: detectedAt,
		}
	}

	runnerID := normalizeRunnerID(task.RunnerID)
	if runnerID != "" {
		if ok, reason := ClassifyRunnerAuthFailureFor(runnerID, text); ok {
			return runnerAuthTaskFailure(runnerID, task.Model, text, reason, detectedAt)
		}
	}
	if hitRunner, reason := ClassifyRunnerAuthFailure(text); hitRunner != "" {
		return runnerAuthTaskFailure(hitRunner, task.Model, text, reason, detectedAt)
	}

	lower := strings.ToLower(text)
	if strings.Contains(lower, "providermodelnotfounderror") || strings.Contains(lower, "provider model not found") {
		return &TaskFailureDiagnosis{
			Kind:       "runner_model",
			Code:       "runner.model.not_found",
			Title:      "Model is not available to this runner",
			Reason:     runnerCapabilityName(runnerID) + " is signed in, but the provider could not open the configured model.",
			Remedy:     "Pick a model listed for this runner on this machine, save it as the machine default, then run Test again before retrying the task.",
			RunnerID:   runnerID,
			Model:      strings.TrimSpace(task.Model),
			Probe:      "subprocess",
			DetectedAt: detectedAt,
			Fix:        runnerConfigFix(runnerID),
		}
	}
	if strings.Contains(lower, "model is not supported") ||
		strings.Contains(lower, "unsupported model") ||
		strings.Contains(lower, "invalid model") ||
		strings.Contains(lower, "does not have access to model") {
		return &TaskFailureDiagnosis{
			Kind:       "runner_model",
			Code:       "runner.model.not_supported",
			Title:      "Selected model is rejected by the account",
			Reason:     runnerCapabilityName(runnerID) + " reached the provider, but the account cannot use the configured model.",
			Remedy:     "Switch to a model your subscription supports, or sign in with the account that owns that model entitlement.",
			RunnerID:   runnerID,
			Model:      strings.TrimSpace(task.Model),
			Probe:      "subprocess",
			DetectedAt: detectedAt,
			Fix:        runnerConfigFix(runnerID),
		}
	}
	// QUOTA EXHAUSTION IS NOT A SUBPROCESS FAULT, AND IT IS NOT FIXABLE BY
	// RETRYING (2026-08-02). The runner said, verbatim:
	//
	//   "You've hit your usage limit. Upgrade to Pro ... or try again at
	//    Aug 8th, 2026 12:38 PM."
	//
	// and the product relayed "a real generation subprocess exited with an
	// error. Open the task details, inspect the subprocess output, then change
	// the model or runner configuration and run Test again." Every word of that
	// remedy is wrong here: the model is fine, the configuration is fine, and
	// running Test again burns another turn against a wall that does not move
	// until a date the runner already named. A whole closed-loop debugging
	// session was spent on model theories because the real sentence never
	// reached a surface.
	//
	// Carry the WHEN through — it is the only actionable fact in the failure.
	if strings.Contains(lower, "usage limit") ||
		strings.Contains(lower, "rate limit") ||
		strings.Contains(lower, "quota exceeded") ||
		strings.Contains(lower, "purchase more credits") {
		reason := runnerCapabilityName(runnerID) + " is signed in and working, but the account has hit its plan usage limit."
		remedy := "Wait for the limit to reset, switch this task to another signed-in runner, or raise the plan. " +
			"Retrying now cannot succeed — the limit is per account, not per task."
		if when := extractRunnerLimitReset(text); when != "" {
			reason += " The runner says it resets at " + when + "."
			remedy = "Resets at " + when + ". Until then, switch this task to another signed-in runner or raise the plan — retrying cannot succeed."
		}
		return &TaskFailureDiagnosis{
			Kind:       "runner_quota",
			Code:       "runner.quota.exhausted",
			Title:      "Runner plan limit reached",
			Reason:     reason,
			Remedy:     remedy,
			RunnerID:   runnerID,
			Model:      strings.TrimSpace(task.Model),
			Probe:      "subprocess",
			DetectedAt: detectedAt,
		}
	}

	// z.ai / GLM (OpenCode's usual provider) speaks in NUMERIC codes, and the
	// two that matter are indistinguishable from a generic crash unless named.
	// Sources: docs.z.ai/api-reference/api-code, plus zai-org/GLM-5#36.
	//
	//   1113 — "insufficient balance or no resource package. Please recharge."
	//          THE TRAP: this also fires on an ACTIVE Coding Plan, because some
	//          endpoints check the pay-as-you-go balance rather than the plan's
	//          quota. So "recharge" is not always the right remedy, and telling
	//          a paying subscriber to top up when their plan is fine is its own
	//          defect. Name both readings and let the user pick.
	//   429  — rate limited (handled by the quota branch above).
	if strings.Contains(lower, "1113") ||
		strings.Contains(lower, "insufficient balance") ||
		strings.Contains(lower, "no resource package") {
		return &TaskFailureDiagnosis{
			Kind:  "runner_provider_billing",
			Code:  "runner.provider.balance_or_plan_scope",
			Title: "z.ai refused the request: balance or plan scope",
			Reason: runnerCapabilityName(runnerID) + " reached z.ai, which returned 1113 — insufficient balance or no resource package. " +
				"On an ACTIVE Coding Plan this usually means the request hit an endpoint that checks the pay-as-you-go balance instead of the plan quota, not that the plan is exhausted.",
			Remedy: "Check the Coding Plan is still active first. If it is, verify this runner's base URL is the coding endpoint " +
				"(https://api.z.ai/api/coding/paas/v4/) — a generic z.ai endpoint bills against pay-as-you-go and 1113s for plan-only keys. Top up only if both are correct.",
			RunnerID:   runnerID,
			Model:      strings.TrimSpace(task.Model),
			Probe:      "subprocess",
			DetectedAt: detectedAt,
			Fix:        runnerConfigFix(runnerID),
		}
	}

	if strings.Contains(lower, "failedtoopensocket") ||
		strings.Contains(lower, "ai_apicallerror") ||
		strings.Contains(lower, "stream error") ||
		strings.Contains(lower, "providerid=") {
		return &TaskFailureDiagnosis{
			Kind:       "runner_provider_transport",
			Code:       "runner.provider.transport",
			Title:      "Provider connection failed",
			Reason:     runnerCapabilityName(runnerID) + " started, but its provider request failed before a usable reply arrived.",
			Remedy:     "Check the provider base URL/API key for this runner on the remote machine, then run Test again.",
			RunnerID:   runnerID,
			Model:      strings.TrimSpace(task.Model),
			Probe:      "subprocess",
			DetectedAt: detectedAt,
			Fix:        runnerConfigFix(runnerID),
		}
	}

	return &TaskFailureDiagnosis{
		Kind:       "runner_subprocess",
		Code:       "runner.subprocess.failed",
		Title:      "Runner subprocess failed",
		Reason:     runnerCapabilityName(runnerID) + " is installed, but a real generation subprocess exited with an error.",
		Remedy:     "Open the task details, inspect the subprocess output, then change the model or runner configuration and run Test again.",
		RunnerID:   runnerID,
		Model:      strings.TrimSpace(task.Model),
		Probe:      "subprocess",
		DetectedAt: detectedAt,
		Fix:        runnerConfigFix(runnerID),
	}
}

func runnerAuthTaskFailure(runnerID, model, text, reason string, detectedAt time.Time) *TaskFailureDiagnosis {
	lower := strings.ToLower(text)
	code := "runner." + normalizeRunnerID(runnerID) + ".auth_required"
	title := "Runner sign-in is invalid"
	if strings.Contains(lower, "token has been revoked") || strings.Contains(lower, "oauth access token has been revoked") {
		code = "runner." + normalizeRunnerID(runnerID) + ".oauth_revoked"
		title = "Runner OAuth grant was revoked"
	}
	return &TaskFailureDiagnosis{
		Kind:       "runner_auth",
		Code:       code,
		Title:      title,
		Reason:     strings.TrimSpace(reason),
		Remedy:     "Start the runner sign-in flow from this task, then run Test before retrying.",
		RunnerID:   normalizeRunnerID(runnerID),
		Model:      strings.TrimSpace(model),
		Probe:      "subprocess",
		DetectedAt: detectedAt,
		Fix: &TaskFailureFix{
			Type:      "runner_browser_auth",
			RunnerID:  normalizeRunnerID(runnerID),
			TestAfter: true,
		},
	}
}

func runnerConfigFix(runnerID string) *TaskFailureFix {
	runnerID = normalizeRunnerID(runnerID)
	if runnerID == "" {
		return nil
	}
	return &TaskFailureFix{
		Type:      "runner_test",
		RunnerID:  runnerID,
		TestAfter: true,
	}
}

// extractRunnerLimitReset pulls the reset moment out of a runner's own
// rate-limit sentence, e.g.
//
//	"...or try again at Aug 8th, 2026 12:38 PM."
//
// Returned verbatim rather than parsed into a time.Time: the runner's phrasing
// is already the clearest thing we can show a user, and a failed parse must
// never swallow the one actionable fact in the message.
func extractRunnerLimitReset(out string) string {
	for _, marker := range []string{"try again at ", "resets at ", "resets on "} {
		i := strings.Index(strings.ToLower(out), marker)
		if i < 0 {
			continue
		}
		rest := out[i+len(marker):]
		if cut := strings.IndexAny(rest, ".\n\r"); cut > 0 {
			rest = rest[:cut]
		}
		rest = strings.TrimSpace(rest)
		if rest != "" && len(rest) <= 80 {
			return rest
		}
	}
	return ""
}
