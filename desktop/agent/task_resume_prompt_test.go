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
// messages.
//
// These guards were written against buildResumePrompt (4edab3d82). They now
// exercise composeTurnPrompt, which is the single composer both spawn paths go
// through — same rule, one implementation instead of two, and it also decides
// when a follow-up is really a COLD spawn that must be briefed again. The one
// permitted addition beyond attachments is the prompt-echo boundary: codex
// echoes the whole prompt on EVERY turn, so stripPromptEcho needs its sentinel
// on every turn or a follow-up's echo lands in ResultText as if the assistant
// had said it. See task_prompt_frame.go.
func resumeOnly(prompt string) string {
	return strings.TrimSuffix(prompt, "\n\n"+promptEchoSentinel+"\n")
}

func TestFollowUpPromptIsVerbatim(t *testing.T) {
	tm := &TaskManager{workDir: t.TempDir()}
	for _, source := range []string{"", "connect", "mcp", "console", "mobile-code", "voice"} {
		task := &Task{ID: "t1", Source: source, WorkDir: tm.workDir}
		in := "revert the background to black"
		got := resumeOnly(tm.composeTurnPrompt(task, in, promptFramePolicy{ArmPreamble: false}))
		if got != in {
			t.Fatalf("source %q: follow-up prompt was rewritten:\n%q", source, got)
		}
	}
}

func TestFollowUpPromptAppendsOnlyAttachments(t *testing.T) {
	tm := &TaskManager{workDir: t.TempDir()}
	task := &Task{ID: "t2", Source: "connect", WorkDir: tm.workDir, ImagePaths: []string{"/tmp/a.png"}}
	got := tm.composeTurnPrompt(task, "what is in the screenshot", promptFramePolicy{ArmPreamble: false})
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

func TestFollowUpPromptRawCommandTrimsOnly(t *testing.T) {
	tm := &TaskManager{workDir: t.TempDir()}
	task := &Task{ID: "t3", Source: "connect", WorkDir: tm.workDir, ImagePaths: []string{"/tmp/a.png"}}
	raw := "  /compact"
	got := tm.composeTurnPrompt(task, raw, promptFramePolicy{ArmPreamble: false, RawRunnerCommand: true})
	if got != strings.TrimLeft(raw, " \t\r\n") {
		t.Fatalf("raw runner command must pass through untouched: %q", got)
	}
}
