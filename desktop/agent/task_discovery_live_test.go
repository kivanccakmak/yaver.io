package main

// Opt-in, read-only headless proof against a developer's real tmux layout.
// It writes Task state only to t.TempDir(), never to ~/.yaver, and Shutdown
// cancels its capture pollers without typing into or closing any pane.

import (
	"context"
	"encoding/json"
	"os"
	"sort"
	"strconv"
	"testing"
	"time"
)

func TestLiveTaskDiscoverySmoke(t *testing.T) {
	sessionName := os.Getenv("YAVER_TEST_LIVE_SESSION")
	if sessionName == "" {
		t.Skip("set YAVER_TEST_LIVE_SESSION to run the read-only live smoke")
	}
	want, err := strconv.Atoi(os.Getenv("YAVER_TEST_LIVE_TASK_COUNT"))
	if err != nil || want < 1 {
		t.Fatal("YAVER_TEST_LIVE_TASK_COUNT must be a positive integer")
	}
	wantRunner := normalizeRunnerID(os.Getenv("YAVER_TEST_LIVE_RUNNER"))
	if wantRunner == "" {
		wantRunner = "codex"
	}
	wantModel := os.Getenv("YAVER_TEST_LIVE_MODEL")
	wantEffort := os.Getenv("YAVER_TEST_LIVE_REASONING")

	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	mgr := NewTmuxManager(tm)
	if mgr == nil {
		t.Fatal("tmux is unavailable")
	}
	tm.TmuxMgr = mgr
	defer mgr.Shutdown()

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	discovered := mgr.ReconcileUntrackedRunnerPanes(ctx)

	tm.mu.RLock()
	var tasks []*Task
	for _, task := range tm.tasks {
		if task != nil && task.TmuxSession == sessionName && task.Status == TaskStatusRunning {
			tasks = append(tasks, task)
		}
	}
	tm.mu.RUnlock()
	sort.Slice(tasks, func(i, j int) bool { return tasks[i].TmuxPaneID < tasks[j].TmuxPaneID })
	if len(tasks) != want {
		t.Fatalf("session %q produced %d Active Tasks (discovered=%d), want %d", sessionName, len(tasks), discovered, want)
	}
	panes := make(map[string]bool, len(tasks))
	for _, task := range tasks {
		if panes[task.TmuxPaneID] {
			t.Fatalf("two Tasks share pane %q", task.TmuxPaneID)
		}
		panes[task.TmuxPaneID] = true
		if normalizeRunnerID(task.RunnerID) != wantRunner {
			t.Errorf("pane %s runner=%q, want %q", task.TmuxPaneID, task.RunnerID, wantRunner)
		}
		if task.Model == "" {
			t.Errorf("pane %s has no locally detected model", task.TmuxPaneID)
		}
		if wantModel != "" && task.Model != wantModel {
			t.Errorf("pane %s model=%q, want %q", task.TmuxPaneID, task.Model, wantModel)
		}
		if wantRunner == "codex" && task.ReasoningEffort == "" {
			t.Errorf("pane %s has no locally detected reasoning effort", task.TmuxPaneID)
		}
		if wantEffort != "" && task.ReasoningEffort != wantEffort {
			t.Errorf("pane %s reasoning=%q, want %q", task.TmuxPaneID, task.ReasoningEffort, wantEffort)
		}
		t.Logf("pane %s: runner=%s model=%s reasoning=%s task=%s", task.TmuxPaneID, task.RunnerID, task.Model, task.ReasoningEffort, task.ID)
	}
	if manifestPath := os.Getenv("YAVER_TEST_LIVE_MANIFEST"); manifestPath != "" {
		type safeTask struct {
			ID              string     `json:"id"`
			Title           string     `json:"title"`
			Description     string     `json:"description"`
			Status          TaskStatus `json:"status"`
			RunnerID        string     `json:"runnerId"`
			Model           string     `json:"model,omitempty"`
			ReasoningEffort string     `json:"reasoningEffort,omitempty"`
			DeviceName      string     `json:"deviceName,omitempty"`
			Source          string     `json:"source"`
			Output          string     `json:"output"`
			IsAdopted       bool       `json:"isAdopted"`
			TmuxSession     string     `json:"tmuxSession"`
			TmuxPaneID      string     `json:"tmuxPaneId"`
			CreatedAt       int64      `json:"createdAt"`
			UpdatedAt       int64      `json:"updatedAt"`
		}
		safeTasks := make([]safeTask, 0, len(tasks))
		hostname, _ := os.Hostname()
		for _, task := range tasks {
			safeTasks = append(safeTasks, safeTask{
				ID: task.ID, Title: task.RunnerName + " task", Description: "Coding task discovered on this machine.",
				Status: task.Status, RunnerID: task.RunnerID,
				Model: task.Model, ReasoningEffort: task.ReasoningEffort, DeviceName: hostname,
				Source: "local-terminal", Output: "", IsAdopted: true,
				TmuxSession: task.TmuxSession, TmuxPaneID: task.TmuxPaneID,
				CreatedAt: task.CreatedAt.UnixMilli(), UpdatedAt: task.LastActiveAt.UnixMilli(),
			})
		}
		payload, err := json.MarshalIndent(map[string]any{
			"session": sessionName,
			"tasks":   safeTasks,
		}, "", "  ")
		if err != nil {
			t.Fatalf("encode safe live manifest: %v", err)
		}
		if err := os.WriteFile(manifestPath, payload, 0o600); err != nil {
			t.Fatalf("write safe live manifest: %v", err)
		}
		t.Logf("wrote prompt-free live Task manifest to %s", manifestPath)
	}
	t.Logf("session %s: %d distinct %s Tasks across panes %v", sessionName, len(tasks), wantRunner, panes)
}
