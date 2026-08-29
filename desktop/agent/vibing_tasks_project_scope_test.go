package main

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"
)

func TestVibingTasksKeepsContainerGuestsProjectScoped(t *testing.T) {
	workspace := t.TempDir()
	sfmgPath := filepath.Join(workspace, "sfmg")
	talosPath := filepath.Join(workspace, "talos")
	tm := NewTaskManager(workspace, nil, defaultTestRunner())
	now := time.Now()
	tm.mu.Lock()
	tm.tasks = map[string]*Task{
		"sfmg": {
			ID: "sfmg", Title: "Make SFMG dark blue", Status: TaskStatusFinished,
			Source: "vibing", ProjectName: "root (sfmg)", WorkDir: sfmgPath, CreatedAt: now,
		},
		"talos": {
			ID: "talos", Title: "Improve Talos", Status: TaskStatusFinished,
			Source: "vibing", ProjectName: "root (talos)", WorkDir: talosPath, CreatedAt: now.Add(-time.Second),
		},
		"unrelated": {
			ID: "unrelated", Title: "Ordinary task", Status: TaskStatusFinished,
			Source: "mobile", ProjectName: "sfmg", WorkDir: sfmgPath, CreatedAt: now.Add(-2 * time.Second),
		},
	}
	tm.mu.Unlock()
	s := &HTTPServer{taskMgr: tm}

	assertGuest := func(name, path, wantID string) {
		t.Helper()
		query := url.Values{"projectName": {name}, "projectPath": {path}}
		req := httptest.NewRequest("GET", "/vibing/tasks?"+query.Encode(), nil)
		rec := httptest.NewRecorder()
		s.handleVibingTasks(rec, req)
		if rec.Code != 200 {
			t.Fatalf("%s list status = %d: %s", name, rec.Code, rec.Body.String())
		}
		var body struct {
			Tasks []struct {
				ID      string `json:"id"`
				WorkDir string `json:"workDir"`
			} `json:"tasks"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode %s list: %v", name, err)
		}
		if len(body.Tasks) != 1 || body.Tasks[0].ID != wantID {
			t.Fatalf("%s topics = %+v, want only %q", name, body.Tasks, wantID)
		}
		if body.Tasks[0].WorkDir != "" {
			t.Fatalf("%s topic leaked absolute workDir %q", name, body.Tasks[0].WorkDir)
		}
	}

	// The container passes the clean guest name, while exact path matching also
	// restores older topics that were stored under discovery labels like
	// `root (sfmg)`.
	assertGuest("sfmg", sfmgPath, "sfmg")
	assertGuest("talos", talosPath, "talos")
}
