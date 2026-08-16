package yaver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestNewClient(t *testing.T) {
	c := NewClient("http://localhost:18080", "test-token")
	if c.BaseURL != "http://localhost:18080" {
		t.Fatalf("expected BaseURL http://localhost:18080, got %s", c.BaseURL)
	}
	if c.AuthToken != "test-token" {
		t.Fatalf("expected AuthToken test-token, got %s", c.AuthToken)
	}
}

func TestHealth(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			t.Fatalf("expected /health, got %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "token")
	if err := c.Health(); err != nil {
		t.Fatalf("Health() failed: %v", err)
	}
}

func TestCreateTask(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/tasks" {
			t.Fatalf("expected POST /tasks, got %s %s", r.Method, r.URL.Path)
		}
		// Check auth header
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Fatalf("expected Bearer test-token, got %s", r.Header.Get("Authorization"))
		}
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		if body["title"] != "Fix the bug" {
			t.Fatalf("expected title 'Fix the bug', got %s", body["title"])
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":       true,
			"taskId":   "abc123",
			"status":   "queued",
			"runnerId": "claude",
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "test-token")
	task, err := c.CreateTask("Fix the bug", nil)
	if err != nil {
		t.Fatalf("CreateTask() failed: %v", err)
	}
	if task.ID != "abc123" {
		t.Fatalf("expected ID abc123, got %s", task.ID)
	}
	if task.Status != "queued" {
		t.Fatalf("expected status queued, got %s", task.Status)
	}
}

func TestCreateTaskWithOptions(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		if body["model"] != "opus" {
			t.Fatalf("expected model opus, got %v", body["model"])
		}
		if body["runner"] != "claude" {
			t.Fatalf("expected runner claude, got %v", body["runner"])
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true, "taskId": "def456", "status": "queued", "runnerId": "claude",
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "token")
	task, err := c.CreateTask("Refactor auth", &CreateTaskOptions{
		Model:  "opus",
		Runner: "claude",
	})
	if err != nil {
		t.Fatalf("CreateTask() failed: %v", err)
	}
	if task.ID != "def456" {
		t.Fatalf("expected ID def456, got %s", task.ID)
	}
}

func TestGetTask(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/tasks/abc123" {
			t.Fatalf("expected /tasks/abc123, got %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"task": map[string]interface{}{
				"id": "abc123", "title": "Fix bug", "status": "completed",
				"resultText": "Fixed the login bug", "createdAt": time.Now(),
			},
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "token")
	task, err := c.GetTask("abc123")
	if err != nil {
		t.Fatalf("GetTask() failed: %v", err)
	}
	if task.Status != "completed" {
		t.Fatalf("expected completed, got %s", task.Status)
	}
	if task.ResultText != "Fixed the login bug" {
		t.Fatalf("expected result text, got %s", task.ResultText)
	}
}

func TestListTasks(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
			"tasks": []map[string]interface{}{
				{"id": "a", "title": "Task A", "status": "completed", "createdAt": time.Now()},
				{"id": "b", "title": "Task B", "status": "running", "createdAt": time.Now()},
			},
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "token")
	tasks, err := c.ListTasks()
	if err != nil {
		t.Fatalf("ListTasks() failed: %v", err)
	}
	if len(tasks) != 2 {
		t.Fatalf("expected 2 tasks, got %d", len(tasks))
	}
}

func TestStopTask(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/tasks/abc123/stop" {
			t.Fatalf("expected POST /tasks/abc123/stop, got %s %s", r.Method, r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"ok": true})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "token")
	if err := c.StopTask("abc123"); err != nil {
		t.Fatalf("StopTask() failed: %v", err)
	}
}

func TestPing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "token")
	rtt, err := c.Ping()
	if err != nil {
		t.Fatalf("Ping() failed: %v", err)
	}
	if rtt <= 0 {
		t.Fatalf("expected positive RTT, got %v", rtt)
	}
}

func TestSpeechConfig(t *testing.T) {
	cfg := &SpeechConfig{
		Provider:   "openai",
		APIKey:     "sk-test",
		TTSEnabled: true,
	}
	tr := NewTranscriber(cfg)
	if tr.Config.Provider != "openai" {
		t.Fatalf("expected openai, got %s", tr.Config.Provider)
	}
}

func TestCheckSpeechDeps(t *testing.T) {
	deps := CheckSpeechDeps(nil)
	// Just verify it returns a map without panicking
	if deps == nil {
		t.Fatal("expected non-nil deps map")
	}
	// can_record should be a boolean
	if _, ok := deps["can_record"]; !ok {
		t.Fatal("expected can_record key")
	}
}
