package main

import "testing"

func TestRawRunnerCommandClassifier(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  bool
	}{
		{"goal", "/goal ship it", true},
		{"leading whitespace", " \n\t/exit", true},
		{"slash later is prose", "please run /goal", false},
		{"empty", "", false},
	}
	for _, tc := range cases {
		if got := isRawRunnerCommand(tc.input); got != tc.want {
			t.Fatalf("%s: isRawRunnerCommand(%q) = %v, want %v", tc.name, tc.input, got, tc.want)
		}
	}
}

func TestRawRunnerPromptPrefersLatestUserSlashCommand(t *testing.T) {
	task := &Task{
		Title:       "title",
		Description: "wrapped description",
		Turns: []ConversationTurn{
			{Role: "user", Content: "normal prompt"},
			{Role: "assistant", Content: "ok"},
			{Role: "user", Content: "  /exit"},
		},
	}
	if got := rawRunnerPromptForTask(task, "fallback"); got != "/exit" {
		t.Fatalf("rawRunnerPromptForTask = %q, want /exit", got)
	}
}
