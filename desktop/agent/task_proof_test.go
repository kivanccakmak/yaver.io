package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildTaskProofWritesLocalMetadataOnly(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	task := &Task{
		ID:           "task/proof 1",
		Title:        "ship android simulator webrtc",
		Status:       TaskStatusFinished,
		RunnerID:     "codex",
		WorkDir:      filepath.Join(t.TempDir(), "mobile"),
		VideoEnabled: true,
		VideoClipID:  "c_test",
		VideoStatus:  "ready",
		Output:       "SECRET_OUTPUT_SHOULD_NOT_APPEAR",
	}

	BuildTaskProof(task, nil)

	dir := filepath.Join(vibePreviewRoot(), "task-proofs", sanitizeMarkerKey(task.ID))
	raw, err := os.ReadFile(filepath.Join(dir, "proof.json"))
	if err != nil {
		t.Fatalf("read proof.json: %v", err)
	}
	if strings.Contains(string(raw), "SECRET_OUTPUT_SHOULD_NOT_APPEAR") || strings.Contains(string(raw), task.WorkDir) {
		t.Fatalf("proof leaked task output or full local path: %s", raw)
	}
	var pkg taskProofPackage
	if err := json.Unmarshal(raw, &pkg); err != nil {
		t.Fatalf("proof json invalid: %v", err)
	}
	if pkg.TaskID != task.ID || pkg.VideoClipID != "c_test" || pkg.WorkDirBase != "mobile" {
		t.Fatalf("unexpected proof package: %+v", pkg)
	}
	if _, err := os.Stat(filepath.Join(dir, "summary.md")); err != nil {
		t.Fatalf("summary.md missing: %v", err)
	}
}

func TestBuildTaskProofSkipsWhenVideoProofNotRequested(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	BuildTaskProof(&Task{ID: "task-no-video", Status: TaskStatusFinished}, nil)
	if _, err := os.Stat(filepath.Join(vibePreviewRoot(), "task-proofs")); !os.IsNotExist(err) {
		t.Fatalf("task-proofs dir should not exist when video proof is off; err=%v", err)
	}
}
