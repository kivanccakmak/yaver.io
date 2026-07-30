package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// task_proof.go writes the optional post-task proof package referenced by the
// task completion hook. It is deliberately local-only: no uploads, no relay
// broadcast, and no task output transcript. The video clip is the evidence; this
// file only packages stable metadata so surfaces and agents can find it.

type taskProofPackage struct {
	TaskID      string `json:"taskId"`
	Title       string `json:"title,omitempty"`
	Status      string `json:"status"`
	RunnerID    string `json:"runnerId,omitempty"`
	WorkDirBase string `json:"workDirBase,omitempty"`
	VideoClipID string `json:"videoClipId,omitempty"`
	VideoStatus string `json:"videoStatus,omitempty"`
	BuiltAt     string `json:"builtAt"`
}

// BuildTaskProof is the richer sibling of MaybeRecordTaskSummary. It writes a
// tiny proof bundle next to vibe-preview artifacts after a successful task when
// video proof was requested. It must never block completion, never upload, and
// never include runner output or credentials.
func BuildTaskProof(t *Task, _ *BlackBoxManager) {
	if t == nil || !t.VideoEnabled || t.Status != TaskStatusFinished {
		return
	}
	id := strings.TrimSpace(t.ID)
	if id == "" {
		return
	}
	pkg := taskProofPackage{
		TaskID:      id,
		Title:       trimProofField(t.Title, 180),
		Status:      string(t.Status),
		RunnerID:    trimProofField(t.RunnerID, 80),
		WorkDirBase: trimProofField(proofWorkDirBase(t.WorkDir), 120),
		VideoClipID: trimProofField(t.VideoClipID, 80),
		VideoStatus: trimProofField(t.VideoStatus, 40),
		BuiltAt:     time.Now().UTC().Format(time.RFC3339Nano),
	}
	if err := writeTaskProofPackage(pkg); err != nil {
		log.Printf("[task-proof] %s: %v", id, err)
	}
}

func writeTaskProofPackage(pkg taskProofPackage) error {
	if strings.TrimSpace(pkg.TaskID) == "" {
		return fmt.Errorf("task id required")
	}
	dir := filepath.Join(vibePreviewRoot(), "task-proofs", sanitizeMarkerKey(pkg.TaskID))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("mkdir proof dir: %w", err)
	}
	raw, err := json.MarshalIndent(pkg, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "proof.json"), append(raw, '\n'), 0o600); err != nil {
		return fmt.Errorf("write proof.json: %w", err)
	}
	md := taskProofMarkdown(pkg)
	if err := os.WriteFile(filepath.Join(dir, "summary.md"), []byte(md), 0o600); err != nil {
		return fmt.Errorf("write summary.md: %w", err)
	}
	return nil
}

func taskProofMarkdown(pkg taskProofPackage) string {
	lines := []string{
		"# Task Proof",
		"",
		"- Task: `" + pkg.TaskID + "`",
		"- Status: `" + pkg.Status + "`",
	}
	if pkg.Title != "" {
		lines = append(lines, "- Title: "+pkg.Title)
	}
	if pkg.RunnerID != "" {
		lines = append(lines, "- Runner: `"+pkg.RunnerID+"`")
	}
	if pkg.WorkDirBase != "" {
		lines = append(lines, "- Project: `"+pkg.WorkDirBase+"`")
	}
	if pkg.VideoClipID != "" {
		lines = append(lines, "- Video clip: `"+pkg.VideoClipID+"`")
	}
	if pkg.VideoStatus != "" {
		lines = append(lines, "- Video status: `"+pkg.VideoStatus+"`")
	}
	if pkg.BuiltAt != "" {
		lines = append(lines, "- Built at: `"+pkg.BuiltAt+"`")
	}
	return strings.Join(lines, "\n") + "\n"
}

func trimProofField(s string, max int) string {
	s = strings.TrimSpace(s)
	if max <= 0 || len(s) <= max {
		return s
	}
	return strings.TrimSpace(s[:max])
}

func proofWorkDirBase(workDir string) string {
	workDir = strings.TrimSpace(workDir)
	if workDir == "" {
		return ""
	}
	base := filepath.Base(workDir)
	if base == "." || base == string(filepath.Separator) {
		return ""
	}
	return base
}
