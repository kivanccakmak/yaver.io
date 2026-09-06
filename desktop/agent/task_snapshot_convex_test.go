package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func resetTaskSnapshotSyncState(t *testing.T, previous *convexSyncer) {
	t.Helper()
	globalTaskSnapshotSync.mu.Lock()
	globalTaskSnapshotSync.lastHash = 0
	globalTaskSnapshotSync.lastSentAt = time.Time{}
	globalTaskSnapshotSync.sent = false
	globalTaskSnapshotSync.mu.Unlock()
	globalConvexSync = previous
}

func TestTaskSnapshotConvexPayloadIsPromptFreeAndDeduplicated(t *testing.T) {
	buf, teardown := installConvexRecorder(t)
	defer teardown()
	previous := globalConvexSync
	globalConvexSync = &convexSyncer{deviceID: "device-1"}
	defer resetTaskSnapshotSyncState(t, previous)

	now := time.Now()
	tm := &TaskManager{tasks: map[string]*Task{
		"task-1": {
			ID: "task-1", YaverSessionID: "session-1", Status: TaskStatusRunning,
			Title: "/Users/private/secret title", Description: "private prompt",
			PromptText: "private source and credentials", Output: "private output",
			CreatedAt: now, LastActiveAt: now,
		},
	}}

	syncTaskSnapshotToConvex(context.Background(), tm)
	tm.mu.Lock()
	tm.tasks["task-1"].LastActiveAt = now.Add(time.Minute)
	tm.mu.Unlock()
	syncTaskSnapshotToConvex(context.Background(), tm)
	if len(*buf) != 1 {
		t.Fatalf("output-only activity made %d Convex mutations, want 1", len(*buf))
	}
	rec := (*buf)[0]
	if rec.Path != "agentTaskSnapshots:sync" {
		t.Fatalf("mutation path = %q", rec.Path)
	}
	raw, err := json.Marshal(rec.Args)
	if err != nil {
		t.Fatal(err)
	}
	var generic map[string]interface{}
	if err := json.Unmarshal(raw, &generic); err != nil {
		t.Fatal(err)
	}
	rec.Args = generic
	assertNoForbiddenFields(t, rec)
	assertNoAbsolutePaths(t, rec)

	rows, ok := generic["tasks"].([]interface{})
	if !ok || len(rows) != 1 {
		t.Fatalf("tasks payload = %#v", generic["tasks"])
	}
	row := rows[0].(map[string]interface{})
	if len(row) != 5 || row["taskId"] != "task-1" || row["yaverSessionId"] != "session-1" || row["status"] != "running" || row["hostKind"] != "runner_process" {
		t.Fatalf("unexpected lifecycle row: %#v", row)
	}

	tm.mu.Lock()
	tm.tasks["task-1"].Status = TaskStatusReview
	tm.mu.Unlock()
	syncTaskSnapshotToConvex(context.Background(), tm)
	if len(*buf) != 2 {
		t.Fatalf("lifecycle transition made %d mutations, want 2", len(*buf))
	}
}

func TestTaskSnapshotExcludesDeletedTasks(t *testing.T) {
	deletedAt := time.Now()
	tm := &TaskManager{tasks: map[string]*Task{
		"live": {ID: "live", YaverSessionID: "session-live", Status: TaskStatusReady, CreatedAt: deletedAt},
		"gone": {ID: "gone", YaverSessionID: "session-gone", Status: TaskStatusStopped, CreatedAt: deletedAt, DeletedAt: &deletedAt},
	}}
	rows := localTaskLifecycleSnapshot(tm)
	if len(rows) != 1 || rows[0].TaskID != "live" {
		t.Fatalf("snapshot should contain only live task, got %#v", rows)
	}
}
