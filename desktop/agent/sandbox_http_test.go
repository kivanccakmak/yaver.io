package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSandboxStatusIncludesEnabledModeAndDefaults(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	baseURL, cancel := startTestServer(t, "tok", tm)
	defer cancel()

	status, body := doRequest(t, "GET", baseURL+"/sandbox/status", "tok", "")
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d", status)
	}
	if body["enabledMode"] != "off" {
		t.Fatalf("expected enabledMode=off, got %v", body["enabledMode"])
	}
	if body["networkMode"] != "host" {
		t.Fatalf("expected networkMode=host, got %v", body["networkMode"])
	}
}

func TestSandboxQuickstartRejectsRemovedGuestMode(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	baseURL, cancel := startTestServer(t, "tok", tm)
	defer cancel()

	reqBody := `{"mode":"guests","buildImage":false}`
	status, body := doRequest(t, "POST", baseURL+"/sandbox/quickstart", "tok", reqBody)
	if status != http.StatusBadRequest {
		t.Fatalf("expected 400 for removed guest mode, got %d body=%v", status, body)
	}
	if errText, _ := body["error"].(string); !strings.Contains(strings.ToLower(errText), "removed") {
		t.Fatalf("expected removed-mode error, got %v", body["error"])
	}
}

func TestApplySandboxQuickstartConfiguresOwnerIsolation(t *testing.T) {
	srv := NewHTTPServer(0, "tok", "user", "device", "", "host", NewTaskManager(t.TempDir(), nil, defaultRunner))
	srv.containerRunner = &ContainerRunner{}
	summary, message, err := srv.applySandboxQuickstart("host", false)
	if err != nil {
		t.Fatalf("applySandboxQuickstart() error = %v", err)
	}
	if !srv.containerizeHost {
		t.Fatal("owner containerization was not enabled")
	}
	if srv.taskMgr.ContainerNetwork != "host" {
		t.Fatalf("expected default network host, got %q", srv.taskMgr.ContainerNetwork)
	}
	if !srv.taskMgr.ContainerReadOnly {
		t.Fatal("expected quickstart to default read-only rootfs on")
	}
	if summary.EnabledMode != "host" {
		t.Fatalf("expected enabled mode host, got %q", summary.EnabledMode)
	}
	if message == "" {
		t.Fatal("expected status message")
	}
}

func TestSandboxConfigRejectsRemovedGuestField(t *testing.T) {
	srv := NewHTTPServer(0, "tok", "user", "device", "", "host", NewTaskManager(t.TempDir(), nil, defaultRunner))
	req := httptest.NewRequest(http.MethodPost, "/sandbox/config", strings.NewReader(`{"containerizeGuests":true}`))
	rr := httptest.NewRecorder()
	srv.handleSandboxConfig(rr, req)
	if rr.Code != http.StatusGone {
		t.Fatalf("expected 410, got %d body=%s", rr.Code, rr.Body.String())
	}
}

func TestSandboxQuickstartResponseIncludesSandboxSummary(t *testing.T) {
	srv := NewHTTPServer(0, "tok", "user", "device", "", "host", NewTaskManager(t.TempDir(), nil, defaultRunner))
	srv.containerRunner = &ContainerRunner{}

	req := strings.NewReader(`{"mode":"host","buildImage":false}`)
	httpReq, _ := http.NewRequest(http.MethodPost, "/sandbox/quickstart", req)
	rr := httptest.NewRecorder()
	srv.handleSandboxQuickstart(rr, httpReq)
	if rr.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d body=%s", rr.Code, rr.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	sandbox, ok := body["sandbox"].(map[string]any)
	if !ok {
		t.Fatalf("expected sandbox object, got %T", body["sandbox"])
	}
	if sandbox["enabledMode"] != "host" {
		t.Fatalf("expected host mode, got %v", sandbox["enabledMode"])
	}
}
