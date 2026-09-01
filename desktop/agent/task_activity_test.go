package main

import "testing"

func TestHumanTaskActivityForCommandHidesTerminalSyntax(t *testing.T) {
	for command, want := range map[string]string{
		"pnpm test -- --runInBand": "Running tests.",
		"git diff --stat":          "Inspecting the project.",
		"npx tsc --noEmit":         "Checking types.",
		"pnpm build":               "Building the project.",
	} {
		if got := humanTaskActivityForCommand(command); got != want {
			t.Errorf("humanTaskActivityForCommand(%q) = %q, want %q", command, got, want)
		}
	}
}

func TestRawTaskActivityNarratorOnlyPromotesKnownPhaseRows(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	task := &Task{ID: "narrator", RunnerID: "codex", eventCh: make(chan map[string]interface{}, 8)}
	narrator := &rawTaskActivityNarrator{tm: tm, task: task}
	narrator.observe("• Exploring\nthis arbitrary assistant sentence must not become status\n• Editing files\n")

	if len(task.Presentation) != 1 {
		t.Fatalf("presentation = %#v", task.Presentation)
	}
	if got, want := task.Presentation[0].Text, "Making the requested changes."; got != want {
		t.Fatalf("presentation text = %q, want %q", got, want)
	}
	if task.Presentation[0].Text == "this arbitrary assistant sentence must not become status" {
		t.Fatal("arbitrary runner prose leaked into semantic status")
	}
}
