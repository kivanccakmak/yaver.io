package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestVibingTaskCompleteIsExplicitSDKLifecycleAction(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultTestRunner())
	task := &Task{ID: "sdk-dogfood-session", Title: "keep me", Source: "mobile-feedback", Status: TaskStatusReview}
	tm.mu.Lock()
	tm.tasks[task.ID] = task
	tm.mu.Unlock()
	s := &HTTPServer{taskMgr: tm}

	req := httptest.NewRequest(http.MethodPost, "/vibing/task/"+task.ID+"/complete", nil)
	rec := httptest.NewRecorder()
	s.handleVibingTaskByID(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	got, ok := tm.GetTask(task.ID)
	if !ok || got.Status != TaskStatusFinished {
		t.Fatalf("task = %#v, want explicitly completed and retained", got)
	}
}
