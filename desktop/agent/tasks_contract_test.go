package main

import (
	"os"
	"strings"
	"testing"
)

// Every task list transport (HTTP, QUIC, mobile, web, and native clients)
// starts from TaskManager.ListTasks. Keep the routing metadata on that shared
// projection: dropping it makes list cards guess from the client's currently
// selected runner/device even though task detail remains correct.
func TestListTasksPreservesAuthoritativeTaskMetadata(t *testing.T) {
	hostname, err := os.Hostname()
	if err != nil {
		t.Fatalf("hostname: %v", err)
	}
	tm := &TaskManager{tasks: map[string]*Task{
		"metadata": {
			ID: "metadata", Title: "Verify metadata", Status: TaskStatusRunning,
			RunnerID: "codex", Model: "gpt-5.6-sol", ReasoningEffort: "high",
			Goal: "Keep list surfaces honest", ProjectName: "yaver",
		},
	}}

	rows := tm.ListTasks()
	if len(rows) != 1 {
		t.Fatalf("ListTasks returned %d rows, want 1", len(rows))
	}
	got := rows[0]
	if got.Model != "gpt-5.6-sol" || got.ReasoningEffort != "high" {
		t.Fatalf("model metadata = %q/%q, want gpt-5.6-sol/high", got.Model, got.ReasoningEffort)
	}
	if got.Goal != "Keep list surfaces honest" {
		t.Fatalf("goal = %q, want task goal", got.Goal)
	}
	if got.ProjectName != "yaver" {
		t.Fatalf("projectName = %q, want yaver", got.ProjectName)
	}
	if got.DeviceName != hostname {
		t.Fatalf("deviceName = %q, want %q", got.DeviceName, hostname)
	}
}

func TestFormatTaskSliceContractRemoteRepoContractExplainsLocalExecution(t *testing.T) {
	contract := &TaskSliceContract{
		RunID:         "run-1",
		NodeID:        "dev",
		DeviceID:      "remote-1",
		DeviceName:    "ubuntu-4gb-hel1-1",
		SourceWorkDir: "/Users/me/project",
		IsolationMode: "remote-repo-contract",
	}

	got := formatTaskSliceContract(contract)
	for _, want := range []string{
		"You are already running on the assigned machine",
		"Do not use SSH",
		"Treat the current filesystem as the assigned machine's workspace",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected contract to contain %q, got:\n%s", want, got)
		}
	}
}
