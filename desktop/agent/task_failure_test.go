package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestDiagnoseTaskFailureClaudeRevokedOAuth(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	task := &Task{
		ID:       "task_1",
		Status:   TaskStatusFailed,
		RunnerID: "claude",
		Model:    "claude-sonnet-4",
		Output:   "Failed to authenticate. API Error: 401 OAuth access token has been revoked.",
	}

	got := diagnoseTaskFailure(task, now)
	if got == nil {
		t.Fatal("diagnosis is nil")
	}
	if got.Kind != "runner_auth" {
		t.Fatalf("kind = %q, want runner_auth", got.Kind)
	}
	if got.Code != "runner.claude.oauth_revoked" {
		t.Fatalf("code = %q, want runner.claude.oauth_revoked", got.Code)
	}
	if got.Fix == nil || got.Fix.Type != "runner_browser_auth" || got.Fix.RunnerID != "claude" || !got.Fix.TestAfter {
		t.Fatalf("fix route missing browser auth: %+v", got.Fix)
	}
	if !strings.Contains(strings.ToLower(got.Reason), "revoked") {
		t.Fatalf("reason does not name revocation: %q", got.Reason)
	}
}

func TestDiagnoseTaskFailureUsesKnownRunnerForGeneric401(t *testing.T) {
	got := diagnoseTaskFailure(&Task{
		ID:       "task_2",
		Status:   TaskStatusFailed,
		RunnerID: "codex",
		Model:    "gpt-5.4",
		Output:   "API Error: 401 Unauthorized",
	}, time.Now())
	if got == nil {
		t.Fatal("diagnosis is nil")
	}
	if got.Code != "runner.codex.auth_required" {
		t.Fatalf("code = %q, want runner.codex.auth_required", got.Code)
	}
	if got.Fix == nil || got.Fix.RunnerID != "codex" {
		t.Fatalf("fix route = %+v, want codex runner auth", got.Fix)
	}
}

func TestTaskInfoCarriesStructuredFailure(t *testing.T) {
	info := TaskInfo{
		ID:     "task_3",
		Status: TaskStatusFailed,
		Failure: &TaskFailureDiagnosis{
			Kind:       "runner_auth",
			Code:       "runner.claude.oauth_revoked",
			Title:      "Runner OAuth grant was revoked",
			Reason:     "Claude Code's OAuth access token has been revoked.",
			Remedy:     "Start the runner sign-in flow from this task, then run Test before retrying.",
			RunnerID:   "claude",
			Model:      "claude-sonnet-4",
			Probe:      "subprocess",
			DetectedAt: time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC),
			Fix:        &TaskFailureFix{Type: "runner_browser_auth", RunnerID: "claude", TestAfter: true},
		},
	}
	data, err := json.Marshal(info)
	if err != nil {
		t.Fatal(err)
	}
	body := string(data)
	for _, want := range []string{`"failure"`, `"code":"runner.claude.oauth_revoked"`, `"type":"runner_browser_auth"`, `"testAfter":true`} {
		if !strings.Contains(body, want) {
			t.Fatalf("TaskInfo JSON missing %s: %s", want, body)
		}
	}
}
