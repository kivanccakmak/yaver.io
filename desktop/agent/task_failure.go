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
