package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestRunnerACPSelectionKeepsUnsupportedSemanticsOnCLI(t *testing.T) {
	t.Setenv("YAVER_TMUX_RUNNER", "")
	t.Setenv("YAVER_TASK_TMUX", "0")
	t.Setenv("YAVER_OPENCODE_ACP", "")
	runner := RunnerConfig{RunnerID: "opencode", Command: "opencode"}

	if ok, reason := shouldUseRunnerACP(&Task{}, runner, "", false); !ok {
		t.Fatalf("plain fresh OpenCode task should use ACP: %s", reason)
	}

	cases := []struct {
		name     string
		task     *Task
		runner   RunnerConfig
		model    string
		raw      bool
		wantText string
	}{
		{name: "different runner", task: &Task{}, runner: RunnerConfig{RunnerID: "glm"}, wantText: "no ACP"},
		{name: "raw command", task: &Task{}, runner: runner, raw: true, wantText: "commands"},
		{name: "resume", task: &Task{ResumeLast: true}, runner: runner, wantText: "resume"},
		{name: "model", task: &Task{}, runner: runner, model: "provider/model", wantText: "model"},
		{name: "mode", task: &Task{}, runner: RunnerConfig{RunnerID: "opencode", Mode: "plan"}, wantText: "mode"},
		{name: "attachment", task: &Task{ImagePaths: []string{"screen.png"}}, runner: runner, wantText: "attachments"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ok, reason := shouldUseRunnerACP(tc.task, tc.runner, tc.model, tc.raw)
			if ok || !strings.Contains(reason, tc.wantText) {
				t.Fatalf("selection=(%v, %q), want false reason containing %q", ok, reason, tc.wantText)
			}
		})
	}
}

func TestRunnerACPDefaultsToAttachableTmuxCLILane(t *testing.T) {
	if !tmuxAvailable() {
		t.Skip("tmux is not installed")
	}
	t.Setenv("YAVER_TMUX_RUNNER", "")
	t.Setenv("YAVER_TASK_TMUX", "")
	ok, reason := shouldUseRunnerACP(&Task{}, RunnerConfig{RunnerID: "opencode", Command: "opencode"}, "", false)
	if ok || !strings.Contains(reason, "tmux") {
		t.Fatalf("OpenCode ACP selection=(%v, %q), want attachable tmux CLI lane", ok, reason)
	}
}

func TestRunnerACPStartupFailureRemainsSafeToFallback(t *testing.T) {
	original := newACPTaskClient
	t.Cleanup(func() { newACPTaskClient = original })
	newACPTaskClient = func(string, string, acpClientOptions) (*acpClient, error) {
		return nil, errors.New("deliberate handshake failure")
	}

	task := newACPTestTask("fallback")
	tm := NewTaskManager(t.TempDir(), nil, task.runner)
	started, err := tm.tryStartRunnerACP(context.Background(), task, "do work", t.TempDir())
	if started || err == nil || !strings.Contains(err.Error(), "deliberate handshake failure") {
		t.Fatalf("started=%v err=%v; want reversible startup failure", started, err)
	}
	if task.Status == TaskStatusRunning || task.SessionID != "" || task.Output != "" {
		t.Fatalf("startup failure mutated execution state: %+v", task)
	}
}

func TestRunnerACPTaskStreamsAndCompletes(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	original := newACPTaskClient
	t.Cleanup(func() { newACPTaskClient = original })
	newACPTaskClient = func(_ string, _ string, opts acpClientOptions) (*acpClient, error) {
		return fakeACPClientWithNotify(t, opts.OnNotify), nil
	}

	task := newACPTestTask("complete")
	tm := NewTaskManager(t.TempDir(), nil, task.runner)
	tm.tasks[task.ID] = task
	ctx, cancel := context.WithCancel(context.Background())
	task.cancel = cancel
	started, err := tm.tryStartRunnerACP(ctx, task, "PING", tm.workDir)
	if err != nil || !started {
		t.Fatalf("start=(%v, %v), want native ACP", started, err)
	}

	select {
	case <-task.doneCh:
	case <-time.After(10 * time.Second):
		t.Fatal("ACP task did not complete")
	}
	if task.Transport != taskTransportACP || task.SessionID != "fake-session-1" {
		t.Fatalf("transport/session = %q/%q", task.Transport, task.SessionID)
	}
	if task.Status != TaskStatusFinished || task.ResultText != "PONG" || task.RawOutput != "PONG" {
		t.Fatalf("completed task mismatch: status=%s result=%q raw=%q", task.Status, task.ResultText, task.RawOutput)
	}
	if task.InputTokens != 10 || task.OutputTokens != 2 {
		t.Fatalf("usage = %d/%d, want 10/2", task.InputTokens, task.OutputTokens)
	}
	foundTransport, foundAgentChunk := false, false
	for len(task.eventCh) > 0 {
		event := <-task.eventCh
		if event["type"] == "runner_transport" && event["transport"] == taskTransportACP {
			foundTransport = true
		}
		if event["type"] == "runner_event" && event["event"] == "agent_message_chunk" {
			foundAgentChunk = true
		}
	}
	if !foundTransport || !foundAgentChunk {
		t.Fatalf("structured ACP events missing: transport=%v agentChunk=%v", foundTransport, foundAgentChunk)
	}
}

func TestRunnerACPTaskCancellationStopsPrompt(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("FAKE_ACP_PROMPT_BLOCK", "1")
	original := newACPTaskClient
	t.Cleanup(func() { newACPTaskClient = original })
	newACPTaskClient = func(_ string, _ string, opts acpClientOptions) (*acpClient, error) {
		return fakeACPClientWithNotify(t, opts.OnNotify), nil
	}

	task := newACPTestTask("cancel")
	tm := NewTaskManager(t.TempDir(), nil, task.runner)
	tm.tasks[task.ID] = task
	ctx, cancel := context.WithCancel(context.Background())
	task.cancel = cancel
	started, err := tm.tryStartRunnerACP(ctx, task, "wait", tm.workDir)
	if err != nil || !started {
		t.Fatalf("start=(%v, %v), want native ACP", started, err)
	}
	if err := tm.StopTask(task.ID); err != nil {
		t.Fatal(err)
	}
	if task.Status != TaskStatusStopped {
		t.Fatalf("status=%s, want stopped", task.Status)
	}
}

func TestRunnerACPEligibleForSubscriptionRunners(t *testing.T) {
	t.Setenv("YAVER_TMUX_RUNNER", "")
	t.Setenv("YAVER_TASK_TMUX", "0")
	for _, runnerID := range []string{"opencode", "codex", "claude"} {
		t.Run(runnerID, func(t *testing.T) {
			ok, reason := shouldUseRunnerACP(&Task{}, RunnerConfig{RunnerID: runnerID}, "", false)
			if !ok {
				t.Fatalf("%s ACP selection = false (%s); task startup must be allowed to attempt ACP then fall back to normal CLI", runnerID, reason)
			}
		})
	}
}

func newACPTestTask(suffix string) *Task {
	runner := RunnerConfig{RunnerID: "opencode", Name: "OpenCode", Command: "opencode", OutputMode: "raw"}
	return &Task{
		ID:          "acp-test-" + suffix,
		Title:       "test",
		Status:      TaskStatusQueued,
		RunnerID:    "opencode",
		Source:      "mcp",
		CreatedAt:   time.Now(),
		runner:      runner,
		outputCh:    make(chan string, 32),
		rawOutputCh: make(chan []byte, 32),
		eventCh:     make(chan map[string]interface{}, 32),
		doneCh:      make(chan struct{}),
	}
}
