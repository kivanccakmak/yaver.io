package main

import (
	"testing"
	"time"
)

func TestDeleteTaskKeepsOnlyPrivateSafeSessionTombstone(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultTestRunner())
	started := time.Now().Add(-time.Minute)
	firstUser := started.Add(time.Second)
	firstAgent := started.Add(2 * time.Second)
	task := &Task{
		ID: "delete-session", Title: "private prompt", Description: "private context",
		PromptText: "private runner briefing", Output: "private stdout", ResultText: "private answer",
		Turns: []ConversationTurn{
			{Role: "user", Content: "secret user message", Timestamp: firstUser},
			{Role: "assistant", Content: "secret agent response", Timestamp: firstAgent},
		},
		WorkDir: "/private/project", ProjectName: "private-project", GitRemote: "private-remote",
		MCPServers: []string{"private-mcp"}, Status: TaskStatusFinished, RunnerID: "codex",
		YaverSessionID: "ys_delete", RemoteBoxID: "box-1", RunnerName: "Codex",
		SessionStartedFrom: "vibing", StartedFromSurface: "mobile", InitialSurface: "mobile",
		SessionStartedAt: started, LastSurface: "web", LastActiveAt: firstAgent,
		SessionID: "runner-session", TmuxSession: "yaver-task-delete-codex",
		TmuxSessionID: "$4", TmuxPaneID: "%9", CreatedAt: started,
	}
	tm.mu.Lock()
	tm.tasks[task.ID] = task
	tm.mu.Unlock()

	if err := tm.DeleteTask(task.ID); err != nil {
		t.Fatalf("delete task: %v", err)
	}
	if _, visible := tm.GetTask(task.ID); visible {
		t.Fatal("deleted session remained visible as a task")
	}
	tombstone := tm.tasks[task.ID]
	if tombstone == nil || tombstone.DeletedAt == nil || tombstone.YaverSessionID != "ys_delete" {
		t.Fatalf("missing session tombstone: %+v", tombstone)
	}
	if tombstone.Title != "" || tombstone.Description != "" || tombstone.PromptText != "" ||
		tombstone.Output != "" || tombstone.ResultText != "" || len(tombstone.Turns) != 0 ||
		tombstone.WorkDir != "" || tombstone.ProjectName != "" || tombstone.GitRemote != "" || len(tombstone.MCPServers) != 0 {
		t.Fatalf("deleted tombstone retained private task context: %+v", tombstone)
	}
	if tombstone.FirstUserMessageAt == nil || !tombstone.FirstUserMessageAt.Equal(firstUser) ||
		tombstone.FirstAgentResponseAt == nil || !tombstone.FirstAgentResponseAt.Equal(firstAgent) {
		t.Fatalf("tombstone lost message lifecycle timestamps: %+v", tombstone)
	}
}
