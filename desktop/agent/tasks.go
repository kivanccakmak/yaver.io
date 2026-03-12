package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os/exec"
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
	TaskStatusFinished TaskStatus = "finished"
	TaskStatusFailed   TaskStatus = "failed"
)

// ClaudeEvent represents a line of stream-json output from Claude CLI.
type ClaudeEvent struct {
	Type      string          `json:"type"`
	SessionID string          `json:"session_id,omitempty"`
	Message   json.RawMessage `json:"message,omitempty"`
	Event     *struct {
		Delta *struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"delta,omitempty"`
	} `json:"event,omitempty"`
	Result *struct {
		Text      string `json:"text,omitempty"`
		SessionID string `json:"session_id,omitempty"`
	} `json:"result,omitempty"`
}

// Task represents a single Claude CLI task running as a subprocess.
type Task struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	Description string     `json:"description"`
	Status      TaskStatus `json:"status"`
	SessionID   string     `json:"session_id,omitempty"`
	Output      string     `json:"output"`
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
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	Description string     `json:"description"`
	Status      TaskStatus `json:"status"`
	SessionID   string     `json:"session_id,omitempty"`
	Output      string     `json:"output,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	StartedAt   *time.Time `json:"started_at,omitempty"`
	FinishedAt  *time.Time `json:"finished_at,omitempty"`
}

// TaskManager manages the lifecycle of tasks.
type TaskManager struct {
	mu      sync.RWMutex
	tasks   map[string]*Task
	workDir string
	store   *TaskStore
}

// NewTaskManager creates a new TaskManager. If store is non-nil, previously
// persisted tasks are loaded from disk (running/queued ones become stopped).
func NewTaskManager(workDir string, store *TaskStore) *TaskManager {
	tasks := make(map[string]*Task)
	if store != nil {
		tasks = store.Load()
	}
	return &TaskManager{
		tasks:   tasks,
		workDir: workDir,
		store:   store,
	}
}

// persist saves the current task map to disk if a store is configured.
// Must be called while tm.mu is held (read or write).
func (tm *TaskManager) persist() {
	if tm.store != nil {
		tm.store.Save(tm.tasks)
	}
}

// CreateTask creates a new task and runs Claude CLI with stream-json RPC mode.
func (tm *TaskManager) CreateTask(title, description string) (*Task, error) {
	id := uuid.New().String()[:8]

	task := &Task{
		ID:          id,
		Title:       title,
		Description: description,
		Status:      TaskStatusQueued,
		CreatedAt:   time.Now(),
		outputCh:    make(chan string, 512),
		doneCh:      make(chan struct{}),
	}

	tm.mu.Lock()
	tm.tasks[id] = task
	tm.persist()
	tm.mu.Unlock()

	if err := tm.startClaudeProcess(task); err != nil {
		task.Status = TaskStatusFailed
		tm.mu.Lock()
		tm.persist()
		tm.mu.Unlock()
		return task, fmt.Errorf("start claude process: %w", err)
	}

	return task, nil
}

// startClaudeProcess spawns Claude CLI with stream-json output for RPC-like control.
func (tm *TaskManager) startClaudeProcess(task *Task) error {
	prompt := task.Title
	if task.Description != "" && task.Description != task.Title {
		prompt = task.Title + "\n\n" + task.Description
	}

	ctx, cancel := context.WithCancel(context.Background())
	task.cancel = cancel

	// Use Claude CLI with stream-json output for structured streaming.
	// --dangerously-skip-permissions: auto-approve all tool use
	// --output-format stream-json: get NDJSON events on stdout
	// --include-partial-messages: stream tokens as they arrive
	// --verbose: include full message metadata
	cmd := exec.CommandContext(ctx,
		"claude",
		"-p", prompt,
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--dangerously-skip-permissions",
	)
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

	task.cmd = cmd

	if err := cmd.Start(); err != nil {
		cancel()
		return fmt.Errorf("start claude: %w", err)
	}

	now := time.Now()
	task.StartedAt = &now
	task.Status = TaskStatusRunning

	// Monitor stdout (stream-json events).
	go tm.readStreamJSON(task, stdout)

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
			} else {
				task.Status = TaskStatusFinished
			}
			now := time.Now()
			task.FinishedAt = &now
		}
		tm.persist()
		tm.mu.Unlock()
		close(task.doneCh)
	}()

	return nil
}

// readStreamJSON reads NDJSON from Claude CLI stdout, extracts text deltas,
// and pushes them to the task's output channel for streaming to mobile.
func (tm *TaskManager) readStreamJSON(task *Task, r io.Reader) {
	defer close(task.outputCh)

	scanner := bufio.NewScanner(r)
	// Increase buffer for large JSON lines.
	scanner.Buffer(make([]byte, 0, 256*1024), 1024*1024)

	var output strings.Builder

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var event ClaudeEvent
		if err := json.Unmarshal(line, &event); err != nil {
			// Not JSON, treat as raw text.
			text := string(line)
			output.WriteString(text)
			output.WriteString("\n")
			tm.mu.Lock()
			task.Output = output.String()
			tm.mu.Unlock()
			select {
			case task.outputCh <- text:
			default:
			}
			continue
		}

		// Extract session ID if present.
		if event.SessionID != "" {
			tm.mu.Lock()
			task.SessionID = event.SessionID
			tm.mu.Unlock()
		}

		// Handle text deltas (streaming tokens).
		if event.Event != nil && event.Event.Delta != nil && event.Event.Delta.Type == "text_delta" {
			text := event.Event.Delta.Text
			output.WriteString(text)
			tm.mu.Lock()
			task.Output = output.String()
			tm.mu.Unlock()
			select {
			case task.outputCh <- text:
			default:
			}
		}

		// Handle final result.
		if event.Result != nil {
			if event.Result.SessionID != "" {
				tm.mu.Lock()
				task.SessionID = event.Result.SessionID
				tm.mu.Unlock()
			}
			if event.Result.Text != "" {
				output.WriteString(event.Result.Text)
				tm.mu.Lock()
				task.Output = output.String()
				tm.mu.Unlock()
			}
		}
	}

	if err := scanner.Err(); err != nil {
		log.Printf("[task %s] scanner error: %v", task.ID, err)
	}
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

// ContinueTask creates a new task that resumes a previous Claude session.
func (tm *TaskManager) ContinueTask(parentID, input string) (*Task, error) {
	tm.mu.RLock()
	parent, ok := tm.tasks[parentID]
	tm.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("task %s not found", parentID)
	}

	id := uuid.New().String()[:8]
	task := &Task{
		ID:          id,
		Title:       fmt.Sprintf("Continue: %s", parent.Title),
		Description: input,
		Status:      TaskStatusQueued,
		CreatedAt:   time.Now(),
		outputCh:    make(chan string, 512),
		doneCh:      make(chan struct{}),
	}

	tm.mu.Lock()
	tm.tasks[id] = task
	tm.persist()
	tm.mu.Unlock()

	// Use --resume with parent session ID if available.
	if err := tm.startContinuation(task, parent.SessionID, input); err != nil {
		task.Status = TaskStatusFailed
		tm.mu.Lock()
		tm.persist()
		tm.mu.Unlock()
		return task, fmt.Errorf("start continuation: %w", err)
	}

	return task, nil
}

// startContinuation spawns Claude CLI resuming a previous session.
func (tm *TaskManager) startContinuation(task *Task, sessionID, prompt string) error {
	ctx, cancel := context.WithCancel(context.Background())
	task.cancel = cancel

	args := []string{
		"-p", prompt,
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--dangerously-skip-permissions",
	}

	// Resume previous session if we have its ID.
	if sessionID != "" {
		args = append(args, "--resume", sessionID)
	}

	cmd := exec.CommandContext(ctx, "claude", args...)
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

	task.cmd = cmd

	if err := cmd.Start(); err != nil {
		cancel()
		return fmt.Errorf("start claude: %w", err)
	}

	now := time.Now()
	task.StartedAt = &now
	task.Status = TaskStatusRunning

	go tm.readStreamJSON(task, stdout)

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
		}
		tm.persist()
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
