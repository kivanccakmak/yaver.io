package main

// task_activity.go turns runner execution evidence into the one sentence a
// person needs while a task is active. The full command and its output remain
// in the P2P-only console/command lanes; this intentionally never copies a
// path, argument, or command transcript into the persisted presentation.

import (
	"regexp"
	"strings"
	"sync"
)

// These are deliberately broad task categories, not a shell parser. A phone
// user needs to know the purpose of a step, not the syntax that happened to
// implement it.
func humanTaskActivityForCommand(command string) string {
	lower := strings.ToLower(strings.TrimSpace(command))
	switch {
	case regexp.MustCompile(`\b(go test|pytest|vitest|jest|cargo test|xcodebuild\b.*\btest|gradle\b.*\btest|(?:pnpm|npm|yarn|bun)\b.*\btest)\b`).MatchString(lower):
		return "Running tests."
	case regexp.MustCompile(`\b(tsc|typecheck|type-check)\b`).MatchString(lower):
		return "Checking types."
	case regexp.MustCompile(`\b(eslint|biome check|golangci-lint|swiftlint|ruff check|\blint\b)`).MatchString(lower):
		return "Checking code quality."
	case regexp.MustCompile(`\b(go build|cargo build|xcodebuild|gradle|assemble|bundle|(?:pnpm|npm|yarn|bun)\b.*\bbuild)\b`).MatchString(lower):
		return "Building the project."
	case regexp.MustCompile(`\b(?:pnpm|npm|yarn|bun)\s+(?:install|i)\b|\b(?:brew|apt(?:-get)?|dnf)\s+install\b`).MatchString(lower):
		return "Installing dependencies."
	case regexp.MustCompile(`\b(git\s+(?:diff|status|show)|rg\b|grep\b|find\b|fd\b|ls\b|sed\b|cat\b|head\b|tail\b|wc\b)`).MatchString(lower):
		return "Inspecting the project."
	case regexp.MustCompile(`\b(git\s+commit)\b`).MatchString(lower):
		return "Preparing a commit."
	case regexp.MustCompile(`\b(git\s+push)\b`).MatchString(lower):
		return "Pushing changes."
	case regexp.MustCompile(`\b(deploy|wrangler deploy|vercel|firebase deploy)\b`).MatchString(lower):
		return "Deploying updates."
	default:
		return "Working on the requested changes."
	}
}

func (tm *TaskManager) presentCommandActivity(task *Task, command string) {
	if tm == nil || task == nil || strings.TrimSpace(command) == "" {
		return
	}
	tm.present(task, taskPresentationInput{
		ID: task.ID + "-activity", Kind: "status", Text: humanTaskActivityForCommand(command),
		Phase: "tool", State: "running",
	})
}

// rawTaskActivityNarrator covers runners whose CLI does not provide a typed
// tool-event stream (notably Codex's terminal renderer). It recognises only
// its compact, user-facing phase labels; arbitrary model prose is never
// promoted into product status.
type rawTaskActivityNarrator struct {
	tm       *TaskManager
	task     *Task
	mu       sync.Mutex
	lastText string
	leftover string
}

func (n *rawTaskActivityNarrator) observe(text string) {
	if n == nil || n.tm == nil || n.task == nil {
		return
	}
	n.mu.Lock()
	n.leftover += text
	lines := strings.Split(n.leftover, "\n")
	n.leftover = lines[len(lines)-1]
	n.mu.Unlock()
	for _, line := range lines[:len(lines)-1] {
		n.present(classifyTerminalLine(line))
	}
}

func (n *rawTaskActivityNarrator) flush() {
	if n == nil {
		return
	}
	n.mu.Lock()
	line := n.leftover
	n.leftover = ""
	n.mu.Unlock()
	if line != "" {
		n.present(classifyTerminalLine(line))
	}
}

func (n *rawTaskActivityNarrator) present(classification terminalLine) {
	status := classification.Activity
	if status == "" {
		return
	}
	n.mu.Lock()
	if status == n.lastText {
		n.mu.Unlock()
		return
	}
	n.lastText = status
	n.mu.Unlock()
	n.tm.present(n.task, taskPresentationInput{
		ID: n.task.ID + "-activity", Kind: "status", Text: status,
		Phase: "coding", State: "running",
	})
}
