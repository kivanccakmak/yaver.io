package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Regression (2026-09-05, MacBook Air -> ubuntu-4gb-hel1-1): `yaver ping`
// worked through the relay, while `yaver code --attach` failed with "relay
// password missing". The terminal path resolved only a URL and discarded the
// candidate's transport headers. Pin both the task POST and its SSE stream: a
// task that starts but cannot stream is the same broken user operation.
func TestHTTPCreateTaskCarriesTerminalTransportHeadersThroughStream(t *testing.T) {
	const relayPassword = "relay-password"
	seenCreate := false
	seenStream := false
	seenWorkDir := ""

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Relay-Password") != relayPassword {
			http.Error(w, "relay password missing", http.StatusUnauthorized)
			return
		}
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/tasks":
			seenCreate = true
			var body struct {
				WorkDir string `json:"workDir"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			seenWorkDir = body.WorkDir
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "taskId": "task-1"})
		case r.Method == http.MethodGet && r.URL.Path == "/tasks/task-1/output":
			seenStream = true
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte("data: {\"type\":\"done\"}\n\n"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := httpCreateTask(ctx, server.Client(), server.URL, "Bearer token", terminalPromptPayload{
		Prompt:       "probe",
		OriginalText: "probe",
	}, TerminalClientOptions{
		WorkDir:          "/srv/yaver-dogfood",
		TransportHeaders: map[string]string{"X-Relay-Password": relayPassword},
	})
	if err != nil {
		t.Fatalf("httpCreateTask() error = %v", err)
	}
	if !seenCreate || !seenStream {
		t.Fatalf("transport header coverage create=%v stream=%v, want both true", seenCreate, seenStream)
	}
	if seenWorkDir != "/srv/yaver-dogfood" {
		t.Fatalf("workDir = %q, want the explicitly attached remote checkout", seenWorkDir)
	}
}

func TestResolveCodeAttachRelayCandidatePreservesRelayPassword(t *testing.T) {
	cfg := &Config{
		RelayPassword: "relay-password",
		RelayServers: []RelayServerConfig{
			{HttpURL: "https://relay.example.com"},
		},
	}
	device := &DeviceInfo{DeviceID: "device-1", Name: "ubuntu", IsOnline: true}

	candidate, err := resolveCodeAttachRelayCandidate(cfg, device)
	if err != nil {
		t.Fatalf("resolveCodeAttachRelayCandidate() error = %v", err)
	}
	if candidate.BaseURL != "https://relay.example.com/d/device-1" {
		t.Fatalf("BaseURL = %q", candidate.BaseURL)
	}
	if got := candidate.Headers["X-Relay-Password"]; got != "relay-password" {
		t.Fatalf("X-Relay-Password = %q, want relay-password", got)
	}
}
