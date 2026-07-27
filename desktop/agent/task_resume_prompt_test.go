package main

import (
	"strings"
	"testing"
)

// Follow-up turns must reach the runner VERBATIM. The first turn carries the
// source contract + capability context; the resumed session keeps them. On
// 2026-07-27 a user's "back to black" follow-up went out wrapped in the mobile
// response contract + capability context — boilerplate the session had already
// read — and the user explicitly directed: no prompt engineering on secondary
// messages. If someone re-adds a wrapper to buildResumePrompt, this fails.
func TestBuildResumePromptIsVerbatim(t *testing.T) {
	for _, source := range []string{"", "connect", "mcp", "console", "mobile-code", "voice"} {
		task := &Task{ID: "t1", Source: source}
		in := "revert the background to black"
		got := buildResumePrompt(task, in)
		if got != in {
			t.Fatalf("source %q: follow-up prompt was rewritten:\n%q", source, got)
		}
	}
}

func TestBuildResumePromptAppendsOnlyAttachments(t *testing.T) {
	task := &Task{ID: "t2", Source: "connect", ImagePaths: []string{"/tmp/a.png"}}
	got := buildResumePrompt(task, "what is in the screenshot")
	if !strings.HasPrefix(got, "what is in the screenshot") {
		t.Fatalf("user message no longer leads the prompt: %q", got)
	}
	if !strings.Contains(got, "/tmp/a.png") {
		t.Fatalf("attachment path missing: %q", got)
	}
	// Attachment note is the ONLY permitted addition — no contracts, no context.
	if strings.Contains(got, "response contract") || strings.Contains(got, "You are running") {
		t.Fatalf("wrapper text leaked into follow-up: %q", got)
	}
}

func TestBuildResumePromptRawCommandTrimsOnly(t *testing.T) {
	task := &Task{ID: "t3", Source: "connect", ImagePaths: []string{"/tmp/a.png"}}
	raw := "  /compact"
	got := buildResumePrompt(task, raw)
	if got != strings.TrimLeft(raw, " \t\r\n") {
		t.Fatalf("raw runner command must pass through untouched: %q", got)
	}
}
