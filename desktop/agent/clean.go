package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"
)

// CleanResult reports what performClean removed.
type CleanResult struct {
	TasksRemoved  int   `json:"tasksRemoved"`
	ImagesRemoved int   `json:"imagesRemoved"`
	LogsCleared   bool  `json:"logsCleared"`
	BytesFreed    int64 `json:"bytesFreed"`
	DryRun        bool  `json:"dryRun,omitempty"`
}

// performClean removes old completed/stopped/failed tasks, their images, and logs.
// It is used by both the CLI `yaver clean` command and the HTTP `POST /agent/clean` endpoint.
func performClean(days int, all bool, dryRun bool) CleanResult {
	dir, err := ConfigDir()
	if err != nil {
		log.Printf("[clean] config dir error: %v", err)
		return CleanResult{}
	}

	var result CleanResult
	cutoff := time.Now().AddDate(0, 0, -days)

	// ── Clean tasks ──────────────────────────────────────────────────
	tasksPath := filepath.Join(dir, "tasks.json")
	data, err := os.ReadFile(tasksPath)
	if err != nil && !os.IsNotExist(err) {
		log.Printf("[clean] read tasks: %v", err)
	}

	var records []persistedTask
	if len(data) > 0 {
		if err := json.Unmarshal(data, &records); err != nil {
			log.Printf("[clean] parse tasks: %v", err)
		}
	}

	var keep []persistedTask
	for _, r := range records {
		removable := r.Status == TaskStatusFinished || r.Status == TaskStatusStopped || r.Status == TaskStatusFailed
		old := all || taskAge(r).Before(cutoff)
		if removable && old {
			result.TasksRemoved++
			// Remove images for this task
			imgDir := filepath.Join(dir, "images", r.ID)
			freed := dirSize(imgDir)
			if freed > 0 {
				result.ImagesRemoved++
				result.BytesFreed += freed
				if !dryRun {
					os.RemoveAll(imgDir)
				}
			}
		} else {
			keep = append(keep, r)
		}
	}

	if !dryRun && result.TasksRemoved > 0 {
		out, err := json.MarshalIndent(keep, "", "  ")
		if err == nil {
			os.WriteFile(tasksPath, out, 0600)
		}
	}

	// ── Clean orphan image dirs (task no longer exists) ──────────────
	imagesDir := filepath.Join(dir, "images")
	if entries, err := os.ReadDir(imagesDir); err == nil {
		keepIDs := make(map[string]bool, len(keep))
		for _, r := range keep {
			keepIDs[r.ID] = true
		}
		for _, e := range entries {
			if e.IsDir() && !keepIDs[e.Name()] {
				imgDir := filepath.Join(imagesDir, e.Name())
				freed := dirSize(imgDir)
				if freed > 0 {
					result.ImagesRemoved++
					result.BytesFreed += freed
				}
				if !dryRun {
					os.RemoveAll(imgDir)
				}
			}
		}
	}

	// ── Truncate log file ────────────────────────────────────────────
	logPath := filepath.Join(dir, "agent.log")
	if info, err := os.Stat(logPath); err == nil && info.Size() > 0 {
		result.BytesFreed += info.Size()
		result.LogsCleared = true
		if !dryRun {
			os.Truncate(logPath, 0)
		}
	}

	result.DryRun = dryRun
	return result
}

// taskAge returns the most relevant timestamp for age comparison.
func taskAge(r persistedTask) time.Time {
	if r.FinishedAt != nil {
		return *r.FinishedAt
	}
	return r.CreatedAt
}

// dirSize returns the total size of all files in a directory.
func dirSize(path string) int64 {
	var total int64
	filepath.Walk(path, func(_ string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			total += info.Size()
		}
		return nil
	})
	return total
}

// formatBytes returns a human-readable byte size.
func formatBytes(b int64) string {
	switch {
	case b >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(b)/float64(1<<30))
	case b >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(b)/float64(1<<20))
	case b >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(b)/float64(1<<10))
	default:
		return fmt.Sprintf("%d B", b)
	}
}
