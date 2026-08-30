package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestNormalizeClientSessionSettingsDerivesCapabilities(t *testing.T) {
	settings := normalizeClientSessionSettings(&ClientSessionSettings{
		RuntimeMode: "dogfood",
		Lane:        "shell",
		UsageMode:   "reload-only",
	}, 7, time.Unix(10, 0))
	if settings.Lane != "browser" || !settings.Dogfood || settings.ChatEnabled || !settings.RenderEnabled {
		t.Fatalf("normalized settings = %+v", settings)
	}
	if settings.Revision != 7 || settings.UpdatedAt.IsZero() {
		t.Fatalf("missing server revision metadata: %+v", settings)
	}
}

func TestUpdateTaskSessionSettingsRevisionsAndPersistsState(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultTestRunner())
	task := &Task{ID: "task-session", CreatedAt: time.Now(), Status: TaskStatusReview}
	tm.tasks[task.ID] = task

	first, err := tm.UpdateTaskSessionSettings(task.ID, &ClientSessionSettings{
		Surface: "feedback-sdk-dogfood", RuntimeMode: "dogfood", Lane: "hermes", UsageMode: "chat-only",
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := tm.UpdateTaskSessionSettings(task.ID, &ClientSessionSettings{
		Surface: "feedback-sdk-dogfood", RuntimeMode: "dogfood", Lane: "webrtc", UsageMode: "reload-and-chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != 1 || second.Revision != 2 || second.Lane != "webrtc" || !second.ChatEnabled || !second.RenderEnabled {
		t.Fatalf("unexpected revisions/settings: first=%+v second=%+v", first, second)
	}
	if task.LastSurface != "feedback-sdk-dogfood" || !task.LastActiveAt.Equal(second.UpdatedAt) {
		t.Fatalf("session provenance not updated: surface=%q active=%s", task.LastSurface, task.LastActiveAt)
	}
	records := snapshotPersistedTasks(tm.tasks)
	if len(records) != 1 || records[0].SessionSettings == nil || records[0].SessionSettings.Revision != 2 {
		t.Fatalf("session settings not persisted: %+v", records)
	}
	payload, err := json.Marshal(records[0].SessionSettings)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(payload), `"chatEnabled":true`) || !strings.Contains(string(payload), `"renderEnabled":true`) {
		t.Fatalf("capability booleans missing from wire JSON: %s", payload)
	}
}
