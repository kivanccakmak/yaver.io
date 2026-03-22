package main

import (
	"testing"
	"time"
)

func TestSessionListEmpty(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	baseURL, cancel := startTestServer(t, "tok", tm)
	defer cancel()

	status, body := doRequest(t, "GET", baseURL+"/session/list", "tok", "")
	if status != 200 {
		t.Fatalf("expected 200, got %d", status)
	}
	if body["ok"] != true {
		t.Fatalf("expected ok=true")
	}
	sessions := body["sessions"]
	if sessions != nil {
		if arr, ok := sessions.([]interface{}); ok && len(arr) != 0 {
			t.Fatalf("expected empty sessions, got %d", len(arr))
		}
	}
}

func TestSessionExportImportRoundTrip(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	tm.DummyMode = true
	baseURL, cancel := startTestServer(t, "tok", tm)
	defer cancel()

	// Create a task
	status, body := doRequest(t, "POST", baseURL+"/tasks", "tok",
		`{"title":"Session transfer test task"}`)
	if status != 201 {
		t.Fatalf("create task: expected 201, got %d: %v", status, body)
	}
	taskID := body["taskId"].(string)

	// Wait for task to complete (dummy mode)
	for i := 0; i < 30; i++ {
		time.Sleep(200 * time.Millisecond)
		_, body = doRequest(t, "GET", baseURL+"/tasks/"+taskID, "tok", "")
		task := body["task"].(map[string]interface{})
		if task["status"] == "completed" {
			break
		}
	}

	// List sessions — should have our task
	status, body = doRequest(t, "GET", baseURL+"/session/list", "tok", "")
	if status != 200 {
		t.Fatalf("session list: expected 200, got %d", status)
	}
	sessions, ok := body["sessions"].([]interface{})
	if !ok || len(sessions) == 0 {
		t.Fatalf("expected at least 1 session, got %v", body["sessions"])
	}

	// Find our task in the list
	found := false
	for _, s := range sessions {
		sess := s.(map[string]interface{})
		if sess["taskId"] == taskID {
			found = true
			if sess["agentType"] != "claude" {
				t.Fatalf("expected agentType=claude, got %v", sess["agentType"])
			}
			break
		}
	}
	if !found {
		t.Fatalf("task %s not found in session list", taskID)
	}

	// Export the session
	status, body = doRequest(t, "POST", baseURL+"/session/export", "tok",
		`{"taskId":"`+taskID+`"}`)
	if status != 200 {
		t.Fatalf("session export: expected 200, got %d: %v", status, body)
	}
	if body["ok"] != true {
		t.Fatalf("export: expected ok=true, got %v", body)
	}

	bundle, ok := body["bundle"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected bundle object, got %T", body["bundle"])
	}
	if bundle["agentType"] != "claude" {
		t.Fatalf("bundle agentType: expected claude, got %v", bundle["agentType"])
	}
	if bundle["version"].(float64) != 1 {
		t.Fatalf("bundle version: expected 1, got %v", bundle["version"])
	}
	bundleTask, ok := bundle["task"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected bundle.task object")
	}
	if bundleTask["title"] != "Session transfer test task" {
		t.Fatalf("bundle task title: expected 'Session transfer test task', got %v", bundleTask["title"])
	}

	// Import the bundle (to same agent — round-trip test)
	importBody := `{"bundle":` + jsonString(bundle) + `}`
	status, body = doRequest(t, "POST", baseURL+"/session/import", "tok", importBody)
	if status != 200 {
		t.Fatalf("session import: expected 200, got %d: %v", status, body)
	}
	if body["ok"] != true {
		t.Fatalf("import: expected ok=true, got %v", body)
	}

	newTaskID, ok := body["taskId"].(string)
	if !ok || newTaskID == "" {
		t.Fatalf("expected taskId in import response, got %v", body["taskId"])
	}

	// Verify the imported task exists
	status, body = doRequest(t, "GET", baseURL+"/tasks/"+newTaskID, "tok", "")
	if status != 200 {
		t.Fatalf("get imported task: expected 200, got %d", status)
	}
	importedTask := body["task"].(map[string]interface{})
	title := importedTask["title"].(string)
	if title != "[Transferred] Session transfer test task" {
		t.Fatalf("imported task title: expected '[Transferred] Session transfer test task', got %q", title)
	}
}

func TestSessionExportNotFound(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	baseURL, cancel := startTestServer(t, "tok", tm)
	defer cancel()

	status, body := doRequest(t, "POST", baseURL+"/session/export", "tok",
		`{"taskId":"nonexistent"}`)
	if status != 500 {
		t.Fatalf("expected 500 for nonexistent task, got %d: %v", status, body)
	}
}

func TestSessionImportBadBundle(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	baseURL, cancel := startTestServer(t, "tok", tm)
	defer cancel()

	// Version too high
	status, body := doRequest(t, "POST", baseURL+"/session/import", "tok",
		`{"bundle":{"version":99,"exportedAt":"now","sourceDevice":"test","agentType":"claude","task":{"title":"test","workDir":"/tmp","runnerId":"claude"}}}`)
	if status != 500 {
		t.Fatalf("expected 500 for unsupported version, got %d: %v", status, body)
	}
}

func TestSessionAuthRequired(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	baseURL, cancel := startTestServer(t, "secret", tm)
	defer cancel()

	status, _ := doRequest(t, "GET", baseURL+"/session/list", "", "")
	if status != 401 {
		t.Fatalf("expected 401 without token, got %d", status)
	}
}
