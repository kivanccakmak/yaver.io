package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// TaskStatus represents the lifecycle state of a task.
type TaskStatus string

const (
	TaskStatusQueued   TaskStatus = "queued"
	TaskStatusRunning  TaskStatus = "running"
	TaskStatusStopped  TaskStatus = "stopped"
	TaskStatusFinished TaskStatus = "completed"
	TaskStatusFailed   TaskStatus = "failed"
)

// RunnerConfig describes how to invoke an AI runner (Claude or a custom tool).
type RunnerConfig struct {
	RunnerID        string   `json:"runnerId"`
	Name            string   `json:"name"`
	Command         string   `json:"command"`
	Args            []string `json:"args"`
	OutputMode      string   `json:"outputMode"` // "stream-json" or "raw"
	ResumeSupported bool     `json:"resumeSupported"`
	ResumeArgs      []string `json:"resumeArgs,omitempty"`
	ExitCommand     string   `json:"exitCommand,omitempty"` // e.g. "/exit" for Claude, "/quit" for Aider
	AutoDetected    bool     `json:"-"`                     // true if user never explicitly chose a runner
}

var defaultRunner = RunnerConfig{
	RunnerID: "claude",
	Name:     "Claude Code",
	Command:  "claude",
	Args: []string{
		"-p", "{prompt}",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--model", "sonnet",
		"--tools", "Bash",
		"--dangerously-skip-permissions",
	},
	OutputMode:      "stream-json",
	ResumeSupported: true,
	ResumeArgs:      []string{"--resume", "{sessionId}"},
	ExitCommand:     "/exit",
}

// exitCommands maps runner IDs to their graceful exit commands.
var exitCommands = map[string]string{
	"claude": "/exit",
	"codex":  "exit",
	"aider":  "/quit",
}

// ClaudeEvent represents a top-level line of stream-json output from Claude CLI.
// With --include-partial-messages, events include:
//   {"type":"system","subtype":"init",...}
//   {"type":"stream_event","event":{...}} — incremental streaming (text_delta, tool_use, etc.)
//   {"type":"assistant","message":{...}}  — complete assistant message (text or tool_use)
//   {"type":"user","message":{...},"tool_use_result":{...}} — tool execution results (stdout/stderr)
//   {"type":"result","result":"...", "total_cost_usd":0.01,...}
type ClaudeEvent struct {
	Type      string          `json:"type"`
	Subtype   string          `json:"subtype,omitempty"`
	SessionID string          `json:"session_id,omitempty"`
	Message   json.RawMessage `json:"message,omitempty"`
	Event     json.RawMessage `json:"event,omitempty"` // For stream_event wrapper
	RawResult json.RawMessage `json:"result,omitempty"`
	TotalCost float64         `json:"total_cost_usd,omitempty"`
	// Tool result (for "user" type events with tool output)
	ToolUseResult *ToolUseResult `json:"tool_use_result,omitempty"`
}

// ToolUseResult contains stdout/stderr from a tool execution.
type ToolUseResult struct {
	Stdout      string `json:"stdout"`
	Stderr      string `json:"stderr"`
	Interrupted bool   `json:"interrupted"`
}

// streamEventInner is the inner event payload inside {"type":"stream_event","event":{...}}.
type streamEventInner struct {
	Type         string          `json:"type"` // message_start, content_block_start, content_block_delta, etc.
	Index        int             `json:"index,omitempty"`
	ContentBlock json.RawMessage `json:"content_block,omitempty"`
	Delta        json.RawMessage `json:"delta,omitempty"`
}

// contentBlockInfo describes a content_block_start payload.
type contentBlockInfo struct {
	Type string `json:"type"` // "text" or "tool_use"
	Name string `json:"name,omitempty"`
}

// deltaInfo describes a content_block_delta payload.
type deltaInfo struct {
	Type        string `json:"type"` // "text_delta" or "input_json_delta"
	Text        string `json:"text,omitempty"`
	PartialJSON string `json:"partial_json,omitempty"`
}

// claudeMessage is the parsed "message" field from assistant events.
type claudeMessage struct {
	Content []struct {
		Type  string          `json:"type"`
		Text  string          `json:"text,omitempty"`
		Name  string          `json:"name,omitempty"`
		Input json.RawMessage `json:"input,omitempty"`
	} `json:"content"`
}

// bashInput is the parsed input from a Bash tool_use.
type bashInput struct {
	Command     string `json:"command"`
	Description string `json:"description,omitempty"`
}

// ConversationTurn represents one user or assistant message in the task conversation.
type ConversationTurn struct {
	Role      string    `json:"role"` // "user" or "assistant"
	Content   string    `json:"content"`
	Timestamp time.Time `json:"timestamp"`
}

// Task represents a single Claude CLI task running as a subprocess.
type Task struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	Description string     `json:"description"`
	Status      TaskStatus `json:"status"`
	Source      string     `json:"source,omitempty"` // "mobile", "mcp", "cli"
	Model       string     `json:"model,omitempty"`
	SessionID   string     `json:"session_id,omitempty"`
	Output      string     `json:"output"`
	ResultText   string  // Extracted clean result text from Claude
	CostUSD      float64 // Total API cost
	Turns       []ConversationTurn // Full conversation history
	CreatedAt   time.Time  `json:"created_at"`
	StartedAt   *time.Time `json:"started_at,omitempty"`
	FinishedAt  *time.Time `json:"finished_at,omitempty"`

	cmd       *exec.Cmd
	cancel    context.CancelFunc
	stdin     io.WriteCloser
	outputCh  chan string
	doneCh    chan struct{}
}

// TaskInfo is the JSON-safe subset returned in listings.
type TaskInfo struct {
	ID          string             `json:"id"`
	Title       string             `json:"title"`
	Description string             `json:"description"`
	Status      TaskStatus         `json:"status"`
	SessionID   string             `json:"sessionId,omitempty"`
	Output      string             `json:"output,omitempty"`
	ResultText  string             `json:"resultText,omitempty"`
	CostUSD     float64            `json:"costUsd,omitempty"`
	Turns       []ConversationTurn `json:"turns,omitempty"`
	CreatedAt   time.Time          `json:"createdAt"`
	StartedAt   *time.Time         `json:"startedAt,omitempty"`
	FinishedAt  *time.Time         `json:"finishedAt,omitempty"`
}

// TaskManager manages the lifecycle of tasks.
type TaskManager struct {
	mu      sync.RWMutex
	tasks   map[string]*Task
	workDir string
	store   *TaskStore
	runner  RunnerConfig
}

// NewTaskManager creates a new TaskManager. If store is non-nil, previously
// persisted tasks are loaded from disk (running/queued ones become stopped).
func NewTaskManager(workDir string, store *TaskStore, runner RunnerConfig) *TaskManager {
	tasks := make(map[string]*Task)
	if store != nil {
		tasks = store.Load()
	}
	// Mark orphaned "running" tasks as failed — they have no live process after restart.
	now := time.Now()
	for _, t := range tasks {
		if t.Status == TaskStatusRunning {
			log.Printf("[task %s] Marking orphaned task as failed (was running before restart)", t.ID)
			t.Status = TaskStatusFailed
			t.FinishedAt = &now
		}
	}
	tm := &TaskManager{
		tasks:   tasks,
		workDir: workDir,
		store:   store,
		runner:  runner,
	}
	tm.persist()
	return tm
}

// persist saves the current task map to disk if a store is configured.
// Must be called while tm.mu is held (read or write).
func (tm *TaskManager) persist() {
	if tm.store != nil {
		tm.store.Save(tm.tasks)
	}
}

// CreateTask creates a new task and runs the configured runner.
// model overrides the default model (e.g. "opus", "sonnet", "haiku") — empty uses runner default.
// source indicates where the task originated: "mobile", "mcp", or "cli" — defaults to "mobile".
func (tm *TaskManager) CreateTask(title, description, model, source string) (*Task, error) {
	if source == "" {
		source = "mobile"
	}
	id := uuid.New().String()[:8]

	now := time.Now()
	task := &Task{
		ID:          id,
		Title:       title,
		Description: description,
		Status:      TaskStatusQueued,
		Source:      source,
		Model:       model,
		CreatedAt:   now,
		outputCh:    make(chan string, 512),
		doneCh:      make(chan struct{}),
		Turns: []ConversationTurn{
			{Role: "user", Content: title, Timestamp: now},
		},
	}

	tm.mu.Lock()
	tm.tasks[id] = task
	tm.persist()
	tm.mu.Unlock()

	log.Printf("[task %s] Starting %s process for: %s", id, tm.runner.Name, title)
	if err := tm.startProcess(task); err != nil {
		log.Printf("[task %s] Failed to start %s: %v", id, tm.runner.Name, err)
		task.Status = TaskStatusFailed
		tm.mu.Lock()
		tm.persist()
		tm.mu.Unlock()
		return task, fmt.Errorf("start process: %w", err)
	}
	log.Printf("[task %s] %s process started (PID %d)", id, tm.runner.Name, task.cmd.Process.Pid)

	return task, nil
}

// buildArgs replaces placeholders in the runner's arg template with actual values.
func (tm *TaskManager) buildArgs(prompt string) []string {
	args := make([]string, len(tm.runner.Args))
	for i, a := range tm.runner.Args {
		args[i] = strings.ReplaceAll(a, "{prompt}", prompt)
	}
	return args
}

// startProcess spawns the configured runner with the task's prompt.
func (tm *TaskManager) startProcess(task *Task) error {
	prompt := task.Title
	if task.Description != "" && task.Description != task.Title {
		prompt = task.Title + "\n\n" + task.Description
	}

	// Prepend local project context if available (capped at 4KB to keep prompt fast)
	if projectCtx := getProjectContext(); projectCtx != "" {
		const maxCtx = 4096
		if len(projectCtx) > maxCtx {
			projectCtx = projectCtx[:maxCtx] + "\n...(truncated)"
		}
		prompt = "Here is context about the user's machine and projects:\n\n" + projectCtx + "\n\n---\n\nUser's task:\n" + prompt
	}

	// Prepend recent session history so the agent knows what user has been working on
	if sessionCtx := getRecentSessionsContext(); sessionCtx != "" {
		prompt = sessionCtx + "\n\n---\n\n" + prompt
	}

	// System prompt: behave as a remote terminal agent, tailored to the task source.
	switch task.Source {
	case "mcp":
		prompt += "\n\nYou are running tasks via MCP from an AI agent. Show what you are doing step by step. Use only terminal commands. Be concise. Format output in markdown."
	case "cli":
		prompt += "\n\nYou are running tasks from a remote CLI terminal. Show what you are doing step by step. Use only terminal commands. Be concise. Format output in markdown."
	default:
		prompt += "\n\nYou are running tasks from a remote mobile device. Show what you are doing step by step. Use only terminal commands. Be concise. Format output in markdown."
	}

	ctx, cancel := context.WithCancel(context.Background())
	task.cancel = cancel

	args := tm.buildArgs(prompt)

	// Override model if specified on the task (e.g. "opus", "sonnet", "haiku").
	if task.Model != "" {
		modelOverride := false
		for i, a := range args {
			if a == "--model" && i+1 < len(args) {
				args[i+1] = task.Model
				modelOverride = true
				break
			}
		}
		if !modelOverride {
			args = append(args, "--model", task.Model)
		}
	}

	cmd := exec.CommandContext(ctx, tm.runner.Command, args...)
	cmd.Dir = tm.workDir

	// Ensure common tool paths are in PATH for background processes.
	home, _ := os.UserHomeDir()
	if home != "" {
		existingPath := os.Getenv("PATH")
		extraPaths := filepath.Join(home, ".local", "bin") + ":" +
			"/opt/homebrew/bin" + ":" +
			"/usr/local/bin"
		cmd.Env = append(os.Environ(), "PATH="+extraPaths+":"+existingPath)
	}

	log.Printf("[task %s] Launching: %s %v (dir=%s)", task.ID, tm.runner.Command, args[:2], tm.workDir)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return fmt.Errorf("stdout pipe: %w", err)
	}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return fmt.Errorf("stderr pipe: %w", err)
	}

	// Set up stdin pipe for graceful exit support.
	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return fmt.Errorf("stdin pipe: %w", err)
	}
	task.stdin = stdinPipe

	task.cmd = cmd

	if err := cmd.Start(); err != nil {
		cancel()
		return fmt.Errorf("start process: %w", err)
	}

	now := time.Now()
	task.StartedAt = &now
	task.Status = TaskStatusRunning

	// Monitor stdout based on output mode.
	if tm.runner.OutputMode == "raw" {
		go tm.readRawOutput(task, stdout)
	} else {
		go tm.readStreamJSON(task, stdout)
	}

	// Drain stderr.
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			log.Printf("[task %s stderr] %s", task.ID, scanner.Text())
		}
	}()

	// Wait for process to exit.
	go func() {
		err := cmd.Wait()
		tm.mu.Lock()
		if task.Status == TaskStatusRunning {
			if err != nil {
				task.Status = TaskStatusFailed
				log.Printf("[task %s] %s process failed: %v", task.ID, tm.runner.Name, err)
			} else {
				task.Status = TaskStatusFinished
				log.Printf("[task %s] %s process finished successfully (output_len=%d)", task.ID, tm.runner.Name, len(task.Output))
			}
			finishNow := time.Now()
			task.FinishedAt = &finishNow
			// Save assistant response as conversation turn
			if task.ResultText != "" {
				task.Turns = append(task.Turns, ConversationTurn{
					Role:      "assistant",
					Content:   task.ResultText,
					Timestamp: finishNow,
				})
			}
		}
		tm.persist()
		// Save session file for recent history (non-blocking)
		go saveSessionFile(task, tm.runner.Name, tm.workDir)
		tm.mu.Unlock()
		close(task.doneCh)
	}()

	return nil
}

// readRawOutput reads plain text lines from stdout (for non-JSON runners).
func (tm *TaskManager) readRawOutput(task *Task, r io.Reader) {
	defer close(task.outputCh)

	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 256*1024), 1024*1024)

	var output strings.Builder
	tm.mu.RLock()
	output.WriteString(task.Output)
	tm.mu.RUnlock()

	for scanner.Scan() {
		line := scanner.Text()
		tm.emit(task, &output, line+"\n")
	}

	if err := scanner.Err(); err != nil {
		log.Printf("[task %s] scanner error: %v", task.ID, err)
	}

	// Store final output as result text for raw runners.
	tm.mu.Lock()
	task.ResultText = task.Output
	tm.mu.Unlock()

	log.Printf("[task %s] Raw output reader finished (output_len=%d)", task.ID, output.Len())
}

// emit pushes text to both the output buffer and the streaming channel.
func (tm *TaskManager) emit(task *Task, output *strings.Builder, text string) {
	output.WriteString(text)
	tm.mu.Lock()
	task.Output = output.String()
	tm.mu.Unlock()
	select {
	case task.outputCh <- text:
	default:
	}
}

// readStreamJSON reads NDJSON from Claude CLI stdout with --include-partial-messages.
// It produces a live markdown stream showing:
//   - Commands Claude is running (from tool_use events)
//   - Terminal output (from tool_result/user events)
//   - Claude's text commentary (from text_delta streaming events)
func (tm *TaskManager) readStreamJSON(task *Task, r io.Reader) {
	defer close(task.outputCh)

	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 256*1024), 1024*1024)

	// Start from existing output (important for resumed tasks).
	var output strings.Builder
	tm.mu.RLock()
	output.WriteString(task.Output)
	tm.mu.RUnlock()

	// Track state for accumulating tool input JSON across deltas.
	var toolInputAccum strings.Builder
	inToolUse := false
	lastEmittedCmd := "" // Prevent duplicate command emissions

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var event ClaudeEvent
		if err := json.Unmarshal(line, &event); err != nil {
			text := string(line)
			tm.emit(task, &output, text+"\n")
			continue
		}

		// Extract session ID if present.
		if event.SessionID != "" {
			tm.mu.Lock()
			task.SessionID = event.SessionID
			tm.mu.Unlock()
		}

		switch event.Type {
		case "stream_event":
			// Parse the inner streaming event.
			if len(event.Event) == 0 {
				continue
			}
			var inner streamEventInner
			if err := json.Unmarshal(event.Event, &inner); err != nil {
				continue
			}

			switch inner.Type {
			case "content_block_start":
				// Check if this is a tool_use or text block.
				if len(inner.ContentBlock) > 0 {
					var cb contentBlockInfo
					if json.Unmarshal(inner.ContentBlock, &cb) == nil {
						if cb.Type == "tool_use" {
							inToolUse = true
							toolInputAccum.Reset()
						}
					}
				}

			case "content_block_delta":
				if len(inner.Delta) == 0 {
					continue
				}
				var d deltaInfo
				if json.Unmarshal(inner.Delta, &d) != nil {
					continue
				}

				if d.Type == "text_delta" && d.Text != "" {
					// Stream Claude's text commentary token-by-token.
					tm.emit(task, &output, d.Text)
					log.Printf("[task %s delta] %s", task.ID, d.Text)
				} else if d.Type == "input_json_delta" && d.PartialJSON != "" {
					// Accumulate tool input JSON fragments.
					toolInputAccum.WriteString(d.PartialJSON)
				}

			case "content_block_stop":
				// If we were accumulating tool input, emit the command (if not already emitted).
				if inToolUse && toolInputAccum.Len() > 0 {
					var bi bashInput
					if json.Unmarshal([]byte(toolInputAccum.String()), &bi) == nil && bi.Command != "" && bi.Command != lastEmittedCmd {
						cmdText := fmt.Sprintf("\n**$ %s**\n", bi.Command)
						tm.emit(task, &output, cmdText)
						lastEmittedCmd = bi.Command
						log.Printf("[task %s cmd] %s", task.ID, bi.Command)
					}
					inToolUse = false
					toolInputAccum.Reset()
				}
			}

		case "assistant":
			// Complete assistant message. We already stream text via text_delta
			// and commands via content_block_stop, so only emit tool_use as fallback
			// if it wasn't already emitted.
			if len(event.Message) > 0 {
				var msg claudeMessage
				if json.Unmarshal(event.Message, &msg) == nil {
					for _, block := range msg.Content {
						if block.Type == "tool_use" && len(block.Input) > 0 {
							var bi bashInput
							if json.Unmarshal(block.Input, &bi) == nil && bi.Command != "" && bi.Command != lastEmittedCmd {
								cmdText := fmt.Sprintf("\n**$ %s**\n", bi.Command)
								tm.emit(task, &output, cmdText)
								lastEmittedCmd = bi.Command
								log.Printf("[task %s cmd-fallback] %s", task.ID, bi.Command)
							}
						}
					}
				}
			}

		case "user":
			// Tool result — contains stdout/stderr from bash execution.
			if event.ToolUseResult != nil {
				stdout := strings.TrimRight(event.ToolUseResult.Stdout, "\n")
				stderr := strings.TrimRight(event.ToolUseResult.Stderr, "\n")
				if stdout != "" {
					resultText := fmt.Sprintf("```\n%s\n```\n", stdout)
					tm.emit(task, &output, resultText)
					log.Printf("[task %s stdout] %s", task.ID, truncate(stdout, 200))
				}
				if stderr != "" {
					errText := fmt.Sprintf("```\n⚠ %s\n```\n", stderr)
					tm.emit(task, &output, errText)
					log.Printf("[task %s stderr-out] %s", task.ID, truncate(stderr, 200))
				}
			}

		case "result":
			// Final result — extract clean text and cost.
			if len(event.RawResult) > 0 {
				var resultStr string
				if err := json.Unmarshal(event.RawResult, &resultStr); err == nil {
					tm.mu.Lock()
					task.ResultText = resultStr
					task.CostUSD = event.TotalCost
					tm.mu.Unlock()
					log.Printf("[task %s result] cost=$%.4f len=%d", task.ID, event.TotalCost, len(resultStr))
				}
			}
		}
	}

	if err := scanner.Err(); err != nil {
		log.Printf("[task %s] scanner error: %v", task.ID, err)
	}
	log.Printf("[task %s] Stream reader finished (output_len=%d)", task.ID, output.Len())
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}

// StopTask stops a running task by cancelling the context (kills the process).
func (tm *TaskManager) StopTask(id string) error {
	tm.mu.Lock()
	task, ok := tm.tasks[id]
	if !ok {
		tm.mu.Unlock()
		return fmt.Errorf("task %s not found", id)
	}
	tm.mu.Unlock()

	if task.cancel != nil {
		task.cancel()
	}

	// Wait for process to exit.
	select {
	case <-task.doneCh:
	case <-time.After(10 * time.Second):
		// Force kill if still alive.
		if task.cmd != nil && task.cmd.Process != nil {
			_ = task.cmd.Process.Kill()
		}
	}

	tm.mu.Lock()
	task.Status = TaskStatusStopped
	now := time.Now()
	task.FinishedAt = &now
	tm.persist()
	tm.mu.Unlock()

	return nil
}

// GracefulStopTask sends the runner's exit command via stdin, waits for graceful exit,
// then falls back to kill if the process doesn't exit in time.
func (tm *TaskManager) GracefulStopTask(id string) error {
	tm.mu.RLock()
	task, ok := tm.tasks[id]
	if !ok {
		tm.mu.RUnlock()
		return fmt.Errorf("task %s not found", id)
	}
	tm.mu.RUnlock()

	if task.Status != TaskStatusRunning && task.Status != TaskStatusQueued {
		return fmt.Errorf("task %s is not running", id)
	}

	// Determine exit command: runner config > known defaults > fallback to kill
	exitCmd := tm.runner.ExitCommand
	if exitCmd == "" {
		if cmd, ok := exitCommands[tm.runner.RunnerID]; ok {
			exitCmd = cmd
		}
	}

	// Try graceful exit via stdin
	if exitCmd != "" && task.stdin != nil {
		log.Printf("[task %s] Sending exit command: %s", id, exitCmd)
		_, err := fmt.Fprintf(task.stdin, "%s\n", exitCmd)
		if err != nil {
			log.Printf("[task %s] Failed to write exit command: %v, falling back to kill", id, err)
		} else {
			// Wait up to 10s for graceful exit
			select {
			case <-task.doneCh:
				log.Printf("[task %s] Gracefully exited", id)
				tm.mu.Lock()
				if task.Status == TaskStatusRunning {
					task.Status = TaskStatusStopped
					now := time.Now()
					task.FinishedAt = &now
				}
				tm.persist()
				tm.mu.Unlock()
				return nil
			case <-time.After(10 * time.Second):
				log.Printf("[task %s] Graceful exit timed out, killing process", id)
			}
		}
	}

	// Fall back to regular stop (kill)
	return tm.StopTask(id)
}

// DeleteTask removes a finished task from history.
func (tm *TaskManager) DeleteTask(id string) error {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	task, ok := tm.tasks[id]
	if !ok {
		return fmt.Errorf("task %s not found", id)
	}
	if task.Status == TaskStatusRunning || task.Status == TaskStatusQueued {
		return fmt.Errorf("cannot delete %s task — stop it first", task.Status)
	}
	delete(tm.tasks, id)
	tm.persist()
	return nil
}

// StopAllTasks stops all running/queued tasks.
func (tm *TaskManager) StopAllTasks() int {
	tm.mu.RLock()
	var ids []string
	for id, t := range tm.tasks {
		if t.Status == TaskStatusRunning || t.Status == TaskStatusQueued {
			ids = append(ids, id)
		}
	}
	tm.mu.RUnlock()

	stopped := 0
	for _, id := range ids {
		if err := tm.StopTask(id); err == nil {
			stopped++
		}
	}
	return stopped
}

// DeleteAllTasks removes all finished tasks from history.
func (tm *TaskManager) DeleteAllTasks() int {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	deleted := 0
	for id, t := range tm.tasks {
		if t.Status != TaskStatusRunning && t.Status != TaskStatusQueued {
			delete(tm.tasks, id)
			deleted++
		}
	}
	tm.persist()
	return deleted
}

// ResumeTask resumes an existing task in-place with a follow-up prompt.
// Output is concatenated, same task ID is kept, and Claude session is resumed.
func (tm *TaskManager) ResumeTask(id, input string) (*Task, error) {
	tm.mu.Lock()
	task, ok := tm.tasks[id]
	if !ok {
		tm.mu.Unlock()
		return nil, fmt.Errorf("task %s not found", id)
	}
	if task.Status == TaskStatusRunning || task.Status == TaskStatusQueued {
		tm.mu.Unlock()
		return nil, fmt.Errorf("task %s is already running", id)
	}

	// Append follow-up to conversation history
	turn := ConversationTurn{
		Role:      "user",
		Content:   input,
		Timestamp: time.Now(),
	}
	task.Turns = append(task.Turns, turn)

	// Add separator to output so streaming output concatenates visually
	separator := fmt.Sprintf("\n\n---\n\n**Follow-up:** %s\n\n", input)
	task.Output += separator
	task.ResultText = "" // Clear previous result — new one will come
	task.FinishedAt = nil
	task.Status = TaskStatusQueued

	// Re-create channels for the new run
	task.outputCh = make(chan string, 512)
	task.doneCh = make(chan struct{})

	tm.persist()
	tm.mu.Unlock()

	log.Printf("[task %s] Resuming with follow-up (session=%s): %s", id, task.SessionID, input)

	if err := tm.startResume(task, input); err != nil {
		tm.mu.Lock()
		task.Status = TaskStatusFailed
		tm.persist()
		tm.mu.Unlock()
		return task, fmt.Errorf("resume task: %w", err)
	}

	return task, nil
}

// startResume spawns the runner resuming the task's existing session (if supported).
func (tm *TaskManager) startResume(task *Task, prompt string) error {
	ctx, cancel := context.WithCancel(context.Background())
	task.cancel = cancel

	args := tm.buildArgs(prompt)

	// Append resume args if the runner supports it and we have a session ID.
	if tm.runner.ResumeSupported && task.SessionID != "" && len(tm.runner.ResumeArgs) > 0 {
		for _, ra := range tm.runner.ResumeArgs {
			args = append(args, strings.ReplaceAll(ra, "{sessionId}", task.SessionID))
		}
	}

	cmd := exec.CommandContext(ctx, tm.runner.Command, args...)
	cmd.Dir = tm.workDir

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return fmt.Errorf("stdout pipe: %w", err)
	}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return fmt.Errorf("stderr pipe: %w", err)
	}

	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return fmt.Errorf("stdin pipe: %w", err)
	}
	task.stdin = stdinPipe

	task.cmd = cmd

	if err := cmd.Start(); err != nil {
		cancel()
		return fmt.Errorf("start process: %w", err)
	}

	now := time.Now()
	task.StartedAt = &now
	task.Status = TaskStatusRunning

	if tm.runner.OutputMode == "raw" {
		go tm.readRawOutput(task, stdout)
	} else {
		go tm.readStreamJSON(task, stdout)
	}

	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			log.Printf("[task %s stderr] %s", task.ID, scanner.Text())
		}
	}()

	go func() {
		err := cmd.Wait()
		tm.mu.Lock()
		if task.Status == TaskStatusRunning {
			if err != nil {
				task.Status = TaskStatusFailed
			} else {
				task.Status = TaskStatusFinished
			}
			now := time.Now()
			task.FinishedAt = &now
			// Save the latest result as a conversation turn
			if task.ResultText != "" {
				task.Turns = append(task.Turns, ConversationTurn{
					Role:      "assistant",
					Content:   task.ResultText,
					Timestamp: now,
				})
			}
		}
		tm.persist()
		go saveSessionFile(task, tm.runner.Name, tm.workDir)
		tm.mu.Unlock()
		close(task.doneCh)
	}()

	return nil
}

// ListTasks returns info about all tasks.
func (tm *TaskManager) ListTasks() []TaskInfo {
	tm.mu.RLock()
	defer tm.mu.RUnlock()

	result := make([]TaskInfo, 0, len(tm.tasks))
	for _, t := range tm.tasks {
		// Only include last 2000 chars of output in listings.
		output := t.Output
		if len(output) > 2000 {
			output = output[len(output)-2000:]
		}
		result = append(result, TaskInfo{
			ID:          t.ID,
			Title:       t.Title,
			Description: t.Description,
			Status:      t.Status,
			SessionID:   t.SessionID,
			Output:      output,
			ResultText:  t.ResultText,
			CostUSD:     t.CostUSD,
			Turns:       t.Turns,
			CreatedAt:   t.CreatedAt,
			StartedAt:   t.StartedAt,
			FinishedAt:  t.FinishedAt,
		})
	}
	return result
}

// GetTask returns a single task by ID.
func (tm *TaskManager) GetTask(id string) (*Task, bool) {
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	t, ok := tm.tasks[id]
	return t, ok
}
