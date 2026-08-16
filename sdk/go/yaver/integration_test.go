//go:build integration

package yaver

import (
	"os"
	"testing"
	"time"
)

// Integration tests — run against a live Yaver agent.
// Start agent first: yaver serve --dummy --port 18080
// Run: go test -tags integration -v ./...
//
// Or set YAVER_TEST_URL and YAVER_TEST_TOKEN env vars.

func getTestClient(t *testing.T) *Client {
	url := os.Getenv("YAVER_TEST_URL")
	token := os.Getenv("YAVER_TEST_TOKEN")
	if url == "" || token == "" {
		t.Skip("YAVER_TEST_URL and YAVER_TEST_TOKEN not set — skipping integration test")
	}
	return NewClient(url, token)
}

func TestIntegration_Health(t *testing.T) {
	c := getTestClient(t)
	if err := c.Health(); err != nil {
		t.Fatalf("Health() failed: %v", err)
	}
}

func TestIntegration_Ping(t *testing.T) {
	c := getTestClient(t)
	rtt, err := c.Ping()
	if err != nil {
		t.Fatalf("Ping() failed: %v", err)
	}
	t.Logf("RTT: %v", rtt)
	if rtt > 5*time.Second {
		t.Fatalf("RTT too high: %v", rtt)
	}
}

func TestIntegration_Info(t *testing.T) {
	c := getTestClient(t)
	info, err := c.Info()
	if err != nil {
		t.Fatalf("Info() failed: %v", err)
	}
	if info.Hostname == "" {
		t.Fatal("expected non-empty hostname")
	}
	t.Logf("Agent: %s v%s (dir=%s)", info.Hostname, info.Version, info.WorkDir)
}

func TestIntegration_TaskLifecycle(t *testing.T) {
	c := getTestClient(t)

	// Create
	task, err := c.CreateTask("Integration test — say hello", nil)
	if err != nil {
		t.Fatalf("CreateTask() failed: %v", err)
	}
	t.Logf("Created task: %s (status=%s)", task.ID, task.Status)

	// Poll until done (max 60s for dummy mode)
	var final *Task
	for i := 0; i < 60; i++ {
		final, err = c.GetTask(task.ID)
		if err != nil {
			t.Fatalf("GetTask() failed: %v", err)
		}
		if final.Status == "completed" || final.Status == "failed" || final.Status == "stopped" {
			break
		}
		time.Sleep(time.Second)
	}

	if final.Status != "completed" {
		t.Fatalf("expected completed, got %s", final.Status)
	}
	t.Logf("Task completed. Output length: %d chars", len(final.Output))

	// List
	tasks, err := c.ListTasks()
	if err != nil {
		t.Fatalf("ListTasks() failed: %v", err)
	}
	found := false
	for _, tsk := range tasks {
		if tsk.ID == task.ID {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("created task not found in list")
	}

	// Delete
	if err := c.DeleteTask(task.ID); err != nil {
		t.Fatalf("DeleteTask() failed: %v", err)
	}
}

func TestIntegration_CreateWithVerbosity(t *testing.T) {
	c := getTestClient(t)
	v := 3
	task, err := c.CreateTask("Low verbosity test", &CreateTaskOptions{
		SpeechContext: &SpeechContext{Verbosity: &v},
	})
	if err != nil {
		t.Fatalf("CreateTask with verbosity failed: %v", err)
	}
	t.Logf("Created task with verbosity=3: %s", task.ID)

	// Clean up
	time.Sleep(2 * time.Second)
	c.StopTask(task.ID)
	c.DeleteTask(task.ID)
}
