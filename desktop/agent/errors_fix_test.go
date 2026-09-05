package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func newTestYaverErrorStore(t *testing.T) *ErrorStore {
	t.Helper()
	return &ErrorStore{
		path:    filepath.Join(t.TempDir(), "errors.json"),
		records: make(map[string]*ErrorRecord),
	}
}

func recordFixableError(t *testing.T, store *ErrorStore, projectPath string) string {
	t.Helper()
	store.Record("phone-1", BlackBoxEvent{
		Type: "error", Message: "boom", Stack: []string{"App.tsx:42"},
		Metadata: map[string]interface{}{
			"code": "app.render.failed", "projectName": "example", "projectPath": projectPath,
		},
	})
	records := store.List(false)
	if len(records) != 1 {
		t.Fatalf("expected one error record, got %d", len(records))
	}
	return records[0].Fingerprint
}

func TestErrorFixFailsHonestlyWithoutTaskManager(t *testing.T) {
	store := newTestYaverErrorStore(t)
	fp := recordFixableError(t, store, t.TempDir())
	s := &HTTPServer{errorStore: store}
	req := httptest.NewRequest(http.MethodPost, "/errors/fix", bytes.NewBufferString(`{"fingerprint":"`+fp+`"}`))
	rec := httptest.NewRecorder()
	s.handleErrorsFix(rec, req)
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "error.fix.runner_unavailable") {
		t.Fatalf("expected named unavailable route, got %d %s", rec.Code, rec.Body.String())
	}
}

func TestErrorFixCreatesDefaultSelectionTask(t *testing.T) {
	workDir := t.TempDir()
	store := newTestYaverErrorStore(t)
	fp := recordFixableError(t, store, workDir)
	tm := NewTaskManager(workDir, nil, defaultTestRunner())
	tm.DummyMode = true
	s := &HTTPServer{errorStore: store, taskMgr: tm}
	req := httptest.NewRequest(http.MethodPost, "/errors/fix", bytes.NewBufferString(`{"fingerprint":"`+fp+`"}`))
	rec := httptest.NewRecorder()
	s.handleErrorsFix(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected task creation, got %d %s", rec.Code, rec.Body.String())
	}
	var body struct {
		TaskID string `json:"taskId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.TaskID == "" {
		t.Fatalf("expected task id: %v %s", err, rec.Body.String())
	}
	task, ok := tm.GetTask(body.TaskID)
	if !ok || task == nil {
		t.Fatal("created task missing")
	}
	if task.WorkDir != workDir || task.Source != "error-fix" {
		t.Fatalf("wrong task routing: workDir=%q source=%q", task.WorkDir, task.Source)
	}
	if task.Model != "" {
		t.Fatalf("explicit model would override the global selection: %q", task.Model)
	}
	if !strings.Contains(task.PromptText, "app.render.failed") || !strings.Contains(task.PromptText, "App.tsx:42") {
		t.Fatalf("captured cause missing from prompt: %q", task.PromptText)
	}
}

func TestLegacyResolveFalseReopensYaverLedger(t *testing.T) {
	store := newTestYaverErrorStore(t)
	fp := recordFixableError(t, store, t.TempDir())
	store.MarkResolved(fp, "fixed")
	s := &HTTPServer{errorStore: store}
	req := httptest.NewRequest(http.MethodPost, "/errors/resolve", bytes.NewBufferString(`{"fingerprint":"`+fp+`","resolved":false}`))
	rec := httptest.NewRecorder()
	s.handleErrorsResolve(rec, req)
	if rec.Code != http.StatusOK || store.Get(fp).Resolved {
		t.Fatalf("legacy resolved=false must reopen, got %d %s", rec.Code, rec.Body.String())
	}
}
