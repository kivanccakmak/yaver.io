package main

import (
	"strings"
	"testing"
)

func TestClassifyTerminalLineSeparatesMechanicsFromHumanChat(t *testing.T) {
	cases := []struct {
		name     string
		line     string
		kind     terminalLineKind
		activity string
	}{
		{"ansi bold shell command", "\x1b[1m**$ pnpm test -- --runInBand**\x1b[0m", terminalLineCommand, "Running tests."},
		{"codex ran command", "• Ran rg -n task mobile/src", terminalLineCommand, "Inspecting the project."},
		{"codex phase", "• Editing task_activity.go", terminalLineProgress, "Making the requested changes."},
		{"diff evidence", "diff --git a/a.go b/a.go", terminalLineDiff, ""},
		{"failure evidence", "Error: permission denied", terminalLineFailure, ""},
		{"spinner decoration", "⠋ Thinking", terminalLineDecoration, ""},
		{"opencode banner", "> build · deepseek-v4-flash", terminalLineDecoration, ""},
		{"opencode tool row", "→ Read app.json", terminalLineDecoration, ""},
		{"tmux exit marker", "__YAVER_EXIT__:0", terminalLineDecoration, ""},
		{"shell prompt", "root@ubuntu:/root/Workspace/sfmg#", terminalLineDecoration, ""},
		{"model prose remains untrusted", "I changed the screen and the tests pass.", terminalLineUnknownText, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyTerminalLine(tc.line)
			if got.Kind != tc.kind || got.Activity != tc.activity {
				t.Fatalf("classifyTerminalLine(%q) = %#v, want kind=%q activity=%q", tc.line, got, tc.kind, tc.activity)
			}
		})
	}
}

// Regression for a real OpenCode task routed through the old tmux CLI lane.
// The raw transcript remains available to a terminal view; the primary mobile
// answer must never make a person read wrapper syntax, TUI rows or command
// output to understand what changed.
func TestHumanReadableRunnerAnswerRemovesOpenCodeTmuxTranscript(t *testing.T) {
	raw := strings.Join([]string{
		"> '; rc=$?; printf ...",
		"> build · deepseek-v4-flash",
		"→ Read app.json",
		"← Edit app.json",
		"Index: /workspace/sfmg/app.json",
		"===================================================================",
		"  adaptiveIcon.backgroundColor: #0F172A",
		"  splash.backgroundColor: #0F172A",
		"",
		"**$ node -e \"console.log('checked')\"**",
		"adaptiveIcon: #0F172A",
		"splash: #0F172A",
		"",
		"Done. The Android adaptive icon background is updated.",
		"",
		"- Changed: `expo.android.adaptiveIcon.backgroundColor` to `#0F172A`",
		"- Preserved: `expo.splash.backgroundColor` at `#0F172A`",
		"- Checked: only `app.json` changed",
		"__YAVER_EXIT__:0",
		"root@ubuntu:/workspace/sfmg#",
	}, "\n")

	got := humanReadableRunnerAnswer(raw)
	want := "Done. The Android adaptive icon background is updated.\n\n- Changed: `expo.android.adaptiveIcon.backgroundColor` to `#0F172A`\n- Preserved: `expo.splash.backgroundColor` at `#0F172A`\n- Checked: only `app.json` changed"
	if got != want {
		t.Fatalf("human answer = %q, want %q", got, want)
	}
}

func TestRawNarratorBuffersSplitTerminalLines(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	task := &Task{ID: "split-terminal", eventCh: make(chan map[string]interface{}, 8)}
	narrator := &rawTaskActivityNarrator{tm: tm, task: task}
	narrator.observe("• Edi")
	if len(task.Presentation) != 0 {
		t.Fatalf("partial terminal line emitted status: %#v", task.Presentation)
	}
	narrator.observe("ting files\n")
	if len(task.Presentation) != 1 || task.Presentation[0].Text != "Making the requested changes." {
		t.Fatalf("buffered presentation = %#v", task.Presentation)
	}
}

func TestHumanReadableRunnerAnswerRejectsTerminalEvidence(t *testing.T) {
	raw := "I updated the task screen.\n\n**$ go test ./...**\n\ndiff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1 +1 @@\n-old\n+new\n\n```go\nfmt.Println(\"hidden\")\n```\n\nThe focused checks pass."
	got := humanReadableRunnerAnswer(raw)
	if got != "I updated the task screen.\n\nThe focused checks pass." {
		t.Fatalf("human answer = %q", got)
	}
}

func TestPresentationSanitizesAssistantMessageAtomically(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	task := &Task{ID: "atomic-presentation", eventCh: make(chan map[string]interface{}, 2)}
	tm.present(task, taskPresentationInput{
		ID: "answer", Kind: "message", Role: "assistant",
		Text: "Done.\n\n**$ go test ./...**\n\nThe check passed.",
	})
	if len(task.Presentation) != 1 || task.Presentation[0].Text != "Done.\n\nThe check passed." {
		t.Fatalf("presentation leaked terminal evidence: %#v", task.Presentation)
	}
	if task.Presentation[0].Visibility != "primary" || task.PresentationSeq != 1 {
		t.Fatalf("presentation lost atomic envelope: %#v seq=%d", task.Presentation[0], task.PresentationSeq)
	}
}
