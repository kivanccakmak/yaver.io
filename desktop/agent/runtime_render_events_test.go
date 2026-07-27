package main

import "testing"

func TestRuntimeRenderReasonFromTaskOutputDetectsPreviewMarkers(t *testing.T) {
	cases := map[string]string{
		`⚙ yaver_web_preview_start {"workDir":"/repo/mobile"}`: "web-preview-start",
		"Web UI bundle rebuilt: 45 files.":                     "web-bundle-ready",
		"Reload sent to active runtime":                        "hot-reload",
		"runtime_command run-guest completed":                  "runtime-command",
		"Edit src/theme/tokens.ts patched":                     "source-change",
		"ordinary runner text":                                 "",
	}
	for text, want := range cases {
		if got := runtimeRenderReasonFromTaskOutput(text); got != want {
			t.Fatalf("runtimeRenderReasonFromTaskOutput(%q) = %q, want %q", text, got, want)
		}
	}
}

func TestEmitRuntimeRenderRequestedIncludesWorkDir(t *testing.T) {
	task := &Task{
		ID:      "task-1",
		WorkDir: "/repo/mobile",
		eventCh: make(chan map[string]interface{}, 1),
	}
	emitRuntimeRenderRequested(task, "web-preview-start", "marker")
	select {
	case ev := <-task.eventCh:
		if ev["type"] != "runtime_render_requested" {
			t.Fatalf("type = %#v", ev["type"])
		}
		if ev["schema"] != RuntimeRenderEventSchema {
			t.Fatalf("schema = %#v", ev["schema"])
		}
		if ev["taskId"] != "task-1" || ev["workDir"] != "/repo/mobile" || ev["reason"] != "web-preview-start" {
			t.Fatalf("unexpected event: %#v", ev)
		}
	default:
		t.Fatal("expected runtime render event")
	}
}
