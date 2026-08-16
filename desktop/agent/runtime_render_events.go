package main

import "strings"

const RuntimeRenderEventSchema = 1

func runtimeRenderReasonFromTaskOutput(text string) string {
	lower := strings.ToLower(text)
	switch {
	case strings.Contains(lower, "yaver_web_preview_start"):
		return "web-preview-start"
	case strings.Contains(lower, "yaver_vibe_preview_start"):
		return "vibe-preview-start"
	case strings.Contains(lower, "web bundle re-exported"),
		strings.Contains(lower, "web ui ready"),
		// RuntimeLabView.tsx posts "Web UI bundle rebuilt: N files." into the
		// task transcript after a fast reload — match the string the product
		// actually prints, not a paraphrase of it.
		strings.Contains(lower, "bundle rebuilt"),
		strings.Contains(lower, "web-js-bundle] ready"):
		return "web-bundle-ready"
	case strings.Contains(lower, "hot reload"),
		strings.Contains(lower, "fast refresh"),
		strings.Contains(lower, "reload sent"):
		return "hot-reload"
	case strings.Contains(lower, "run-guest"),
		strings.Contains(lower, "launch-app"):
		return "runtime-command"
	case strings.Contains(lower, "files changed"),
		strings.Contains(lower, "file changed"),
		strings.Contains(lower, "saved"),
		strings.Contains(lower, "patched"),
		strings.Contains(lower, "updated"):
		return "source-change"
	default:
		return ""
	}
}

func emitRuntimeRenderRequested(task *Task, reason, text string) {
	if task == nil || strings.TrimSpace(reason) == "" {
		return
	}
	workDir := strings.TrimSpace(task.WorkDir)
	if workDir == "" && activeTaskManager != nil {
		workDir = strings.TrimSpace(activeTaskManager.workDir)
	}
	snippet := strings.TrimSpace(text)
	if len(snippet) > 500 {
		snippet = snippet[:500]
	}
	emitTaskEvent(task, map[string]interface{}{
		"type":    "runtime_render_requested",
		"schema":  RuntimeRenderEventSchema,
		"taskId":  task.ID,
		"reason":  reason,
		"workDir": workDir,
		"snippet": snippet,
		"ts":      nowMillis(),
	})
}
