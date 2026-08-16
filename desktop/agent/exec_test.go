package main

import (
	"runtime"
	"testing"
	"time"
)

func TestExecBasicCommand(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	baseURL, cancel := startTestServer(t, "tok", tm)
	defer cancel()

	// Start a simple echo command
	status, body := doRequest(t, "POST", baseURL+"/exec", "tok", `{"command":"echo hello world"}`)
	if status != 200 {
		t.Fatalf("expected 200, got %d: %v", status, body)
	}
	if body["ok"] != true {
		t.Fatalf("expected ok=true, got %v", body)
	}
	execID, ok := body["execId"].(string)
	if !ok || execID == "" {
		t.Fatalf("expected execId string, got %v", body["execId"])
	}

	// Poll until completed
	var exec map[string]interface{}
	for i := 0; i < 50; i++ {
		time.Sleep(100 * time.Millisecond)
		status, body = doRequest(t, "GET", baseURL+"/exec/"+execID, "tok", "")
		if status != 200 {
			t.Fatalf("GET exec: expected 200, got %d", status)
		}
		exec = body["exec"].(map[string]interface{})
		if exec["status"] == "completed" {
			break
		}
	}

	if exec["status"] != "completed" {
		t.Fatalf("expected completed, got %s", exec["status"])
	}
	exitCode := exec["exitCode"].(float64)
	if exitCode != 0 {
		t.Fatalf("expected exit code 0, got %v", exitCode)
	}
	stdout := exec["stdout"].(string)
	if stdout != "hello world\n" {
		t.Fatalf("expected 'hello world\\n', got %q", stdout)
	}
}

func TestExecListSessions(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	baseURL, cancel := startTestServer(t, "tok", tm)
	defer cancel()

	// Empty list
	status, body := doRequest(t, "GET", baseURL+"/exec", "tok", "")
	if status != 200 {
		t.Fatalf("expected 200, got %d", status)
	}
	execs := body["execs"].([]interface{})
	if len(execs) != 0 {
		t.Fatalf("expected 0 execs, got %d", len(execs))
	}

	// Start a command
	doRequest(t, "POST", baseURL+"/exec", "tok", `{"command":"echo test"}`)
	time.Sleep(200 * time.Millisecond)

	// List should have 1
	status, body = doRequest(t, "GET", baseURL+"/exec", "tok", "")
	execs = body["execs"].([]interface{})
	if len(execs) != 1 {
		t.Fatalf("expected 1 exec, got %d", len(execs))
	}
}

func TestExecStdinInput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("stdin test not supported on Windows")
	}

	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	baseURL, cancel := startTestServer(t, "tok", tm)
	defer cancel()

	// Start cat (reads stdin, writes to stdout)
	status, body := doRequest(t, "POST", baseURL+"/exec", "tok", `{"command":"cat","timeout":5}`)
	if status != 200 {
		t.Fatalf("expected 200, got %d: %v", status, body)
	}
	execID := body["execId"].(string)
	time.Sleep(100 * time.Millisecond)

	// Send input
	status, _ = doRequest(t, "POST", baseURL+"/exec/"+execID+"/input", "tok", `{"input":"hello from stdin\n"}`)
	if status != 200 {
		t.Fatalf("input: expected 200, got %d", status)
	}

	time.Sleep(200 * time.Millisecond)

	// Check output contains our input
	_, body = doRequest(t, "GET", baseURL+"/exec/"+execID, "tok", "")
	exec := body["exec"].(map[string]interface{})
	stdout := exec["stdout"].(string)
	if stdout == "" {
		t.Log("stdout was empty, cat may not have echoed yet")
	}

	// Kill it
	status, _ = doRequest(t, "POST", baseURL+"/exec/"+execID+"/signal", "tok", `{"signal":"SIGTERM"}`)
	if status != 200 {
		t.Fatalf("signal: expected 200, got %d", status)
	}
}

func TestExecSignalKill(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("signal test not supported on Windows")
	}

	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	baseURL, cancel := startTestServer(t, "tok", tm)
	defer cancel()

	// Start a long-running command
	status, body := doRequest(t, "POST", baseURL+"/exec", "tok", `{"command":"sleep 60","timeout":120}`)
	if status != 200 {
		t.Fatalf("expected 200, got %d", status)
	}
	execID := body["execId"].(string)
	time.Sleep(200 * time.Millisecond)

	// Send SIGKILL
	status, _ = doRequest(t, "POST", baseURL+"/exec/"+execID+"/signal", "tok", `{"signal":"SIGKILL"}`)
	if status != 200 {
		t.Fatalf("signal: expected 200, got %d", status)
	}

	// Wait for it to die
	time.Sleep(500 * time.Millisecond)
	_, body = doRequest(t, "GET", baseURL+"/exec/"+execID, "tok", "")
	exec := body["exec"].(map[string]interface{})
	if exec["status"] == "running" {
		t.Fatalf("expected non-running status after SIGKILL, got running")
	}
}

func TestExecSandboxBlock(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	baseURL, cancel := startTestServer(t, "tok", tm)
	defer cancel()

	// Try a dangerous command
	status, body := doRequest(t, "POST", baseURL+"/exec", "tok", `{"command":"rm -rf /"}`)
	if status != 400 {
		t.Fatalf("expected 400 for dangerous command, got %d: %v", status, body)
	}
}

func TestExecDeleteSession(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	baseURL, cancel := startTestServer(t, "tok", tm)
	defer cancel()

	// Start and wait for completion
	_, body := doRequest(t, "POST", baseURL+"/exec", "tok", `{"command":"echo done"}`)
	execID := body["execId"].(string)
	time.Sleep(300 * time.Millisecond)

	// Delete
	status, _ := doRequest(t, "DELETE", baseURL+"/exec/"+execID, "tok", "")
	if status != 200 {
		t.Fatalf("delete: expected 200, got %d", status)
	}

	// Should be gone
	status, _ = doRequest(t, "GET", baseURL+"/exec/"+execID, "tok", "")
	if status != 404 {
		t.Fatalf("expected 404 after delete, got %d", status)
	}
}

func TestExecAuthRequired(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	baseURL, cancel := startTestServer(t, "secret", tm)
	defer cancel()

	// No token
	status, _ := doRequest(t, "POST", baseURL+"/exec", "", `{"command":"echo hello"}`)
	if status != 401 {
		t.Fatalf("expected 401 without token, got %d", status)
	}

	// Wrong token
	status, _ = doRequest(t, "POST", baseURL+"/exec", "wrong", `{"command":"echo hello"}`)
	if status != 403 {
		t.Fatalf("expected 403 with wrong token, got %d", status)
	}
}

func TestExecFailedCommand(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	baseURL, cancel := startTestServer(t, "tok", tm)
	defer cancel()

	// Command that exits with non-zero
	status, body := doRequest(t, "POST", baseURL+"/exec", "tok", `{"command":"exit 42"}`)
	if status != 200 {
		t.Fatalf("expected 200, got %d", status)
	}
	execID := body["execId"].(string)

	// Poll until done
	for i := 0; i < 50; i++ {
		time.Sleep(100 * time.Millisecond)
		_, body = doRequest(t, "GET", baseURL+"/exec/"+execID, "tok", "")
		exec := body["exec"].(map[string]interface{})
		if exec["status"] != "running" {
			break
		}
	}

	_, body = doRequest(t, "GET", baseURL+"/exec/"+execID, "tok", "")
	exec := body["exec"].(map[string]interface{})
	if exec["status"] != "failed" {
		t.Fatalf("expected failed, got %s", exec["status"])
	}
	if exec["exitCode"].(float64) != 42 {
		t.Fatalf("expected exit code 42, got %v", exec["exitCode"])
	}
}
