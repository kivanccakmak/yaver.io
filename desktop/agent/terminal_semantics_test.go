package main

import "testing"

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
		ID: "answer", Kind: "future_agent_activity", Role: "assistant",
		Text: "Done.\n\n**$ go test ./...**\n\nThe check passed.",
	})
	if len(task.Presentation) != 1 || task.Presentation[0].Text != "Done.\n\nThe check passed." {
		t.Fatalf("presentation leaked terminal evidence: %#v", task.Presentation)
	}
	if task.Presentation[0].Visibility != "primary" || task.PresentationSeq != 1 {
		t.Fatalf("presentation lost atomic envelope: %#v seq=%d", task.Presentation[0], task.PresentationSeq)
	}
}
