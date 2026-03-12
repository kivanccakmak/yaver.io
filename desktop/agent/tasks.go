package main

import (
	"bufio"
	"fmt"
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
	TaskStatusFinished TaskStatus = "finished"
	TaskStatusFailed   TaskStatus = "failed"
)

// Task represents a single Claude CLI task running in a tmux session.
type Task struct {
	ID           string     `json:"id"`
	Title        string     `json:"title"`
	Description  string     `json:"description"`
	Status       TaskStatus `json:"status"`
	TmuxSession  string     `json:"tmux_session"`
	Output       string     `json:"output"`
	CreatedAt    time.Time  `json:"created_at"`
	StartedAt    *time.Time `json:"started_at,omitempty"`
	FinishedAt   *time.Time `json:"finished_at,omitempty"`
	logPath      string
	outputCh     chan string
	stopMonitor  chan struct{}
}

// TaskInfo is the JSON-safe subset returned in listings.
type TaskInfo struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	Description string     `json:"description"`
	Status      TaskStatus `json:"status"`
	CreatedAt   time.Time  `json:"created_at"`
	StartedAt   *time.Time `json:"started_at,omitempty"`
	FinishedAt  *time.Time `json:"finished_at,omitempty"`
}

// TaskManager manages the lifecycle of tasks.
type TaskManager struct {
	mu      sync.RWMutex
	tasks   map[string]*Task
	workDir string
}

// NewTaskManager creates a new TaskManager.
func NewTaskManager(workDir string) *TaskManager {
	return &TaskManager{
		tasks:   make(map[string]*Task),
		workDir: workDir,
	}
}

// CreateTask creates a new task, starts Claude CLI in a tmux session, and
// begins monitoring its output.
func (tm *TaskManager) CreateTask(title, description string) (*Task, error) {
	id := uuid.New().String()[:8]
	sessionName := fmt.Sprintf("yaver-%s", id)

	logDir := filepath.Join(tm.workDir, ".yaver", "logs")
	if err := os.MkdirAll(logDir, 0755); err != nil {
		return nil, fmt.Errorf("create log dir: %w", err)
	}
	logPath := filepath.Join(logDir, fmt.Sprintf("%s.log", id))

	task := &Task{
		ID:          id,
		Title:       title,
		Description: description,
		Status:      TaskStatusQueued,
		TmuxSession: sessionName,
		CreatedAt:   time.Now(),
		logPath:     logPath,
		outputCh:    make(chan string, 256),
		stopMonitor: make(chan struct{}),
	}

	tm.mu.Lock()
	tm.tasks[id] = task
	tm.mu.Unlock()

	if err := tm.startTmuxSession(task); err != nil {
		task.Status = TaskStatusFailed
		return task, fmt.Errorf("start tmux session: %w", err)
	}

	return task, nil
}

// startTmuxSession creates a tmux session running the Claude CLI.
func (tm *TaskManager) startTmuxSession(task *Task) error {
	// Build the prompt from title + description.
	prompt := task.Title
	if task.Description != "" {
		prompt = prompt + "\n\n" + task.Description
	}

	// Create a new detached tmux session running Claude CLI.
	claudeCmd := fmt.Sprintf(
		"claude --dangerously-skip-permissions -p %q",
		prompt,
	)

	cmd := exec.Command("tmux", "new-session", "-d", "-s", task.TmuxSession, claudeCmd)
	cmd.Dir = tm.workDir
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tmux new-session: %s: %w", string(out), err)
	}

	// Pipe tmux pane output to log file.
	pipeCmd := exec.Command("tmux", "pipe-pane", "-t", task.TmuxSession, fmt.Sprintf("cat >> %s", task.logPath))
	if out, err := pipeCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tmux pipe-pane: %s: %w", string(out), err)
	}

	now := time.Now()
	task.StartedAt = &now
	task.Status = TaskStatusRunning

	// Start monitoring the log file for output.
	go tm.monitorOutput(task)

	return nil
}

// monitorOutput tails the task log file and pushes new lines into outputCh.
func (tm *TaskManager) monitorOutput(task *Task) {
	defer close(task.outputCh)

	// Wait for log file to appear.
	var f *os.File
	for i := 0; i < 50; i++ {
		var err error
		f, err = os.Open(task.logPath)
		if err == nil {
			break
		}
		select {
		case <-task.stopMonitor:
			return
		case <-time.After(100 * time.Millisecond):
		}
	}
	if f == nil {
		log.Printf("task %s: log file never appeared at %s", task.ID, task.logPath)
		return
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	var output strings.Builder

	for {
		select {
		case <-task.stopMonitor:
			return
		default:
		}

		if scanner.Scan() {
			line := scanner.Text()
			output.WriteString(line)
			output.WriteString("\n")

			tm.mu.Lock()
			task.Output = output.String()
			tm.mu.Unlock()

			select {
			case task.outputCh <- line:
			default:
				// Drop line if channel is full.
			}
		} else {
			// Check if tmux session is still alive.
			if !tm.isTmuxSessionAlive(task.TmuxSession) {
				tm.mu.Lock()
				if task.Status == TaskStatusRunning {
					task.Status = TaskStatusFinished
					now := time.Now()
					task.FinishedAt = &now
				}
				tm.mu.Unlock()
				return
			}
			time.Sleep(200 * time.Millisecond)
		}
	}
}

// isTmuxSessionAlive checks whether the tmux session still exists.
func (tm *TaskManager) isTmuxSessionAlive(session string) bool {
	cmd := exec.Command("tmux", "has-session", "-t", session)
	return cmd.Run() == nil
}

// StopTask stops a running task by sending /exit to Claude and killing the tmux session.
func (tm *TaskManager) StopTask(id string) error {
	tm.mu.Lock()
	task, ok := tm.tasks[id]
	if !ok {
		tm.mu.Unlock()
		return fmt.Errorf("task %s not found", id)
	}
	tm.mu.Unlock()

	// Send /exit to the tmux session.
	sendCmd := exec.Command("tmux", "send-keys", "-t", task.TmuxSession, "/exit", "Enter")
	_ = sendCmd.Run()

	// Give Claude a moment to exit gracefully.
	time.Sleep(2 * time.Second)

	// Kill the session if still alive.
	if tm.isTmuxSessionAlive(task.TmuxSession) {
		killCmd := exec.Command("tmux", "kill-session", "-t", task.TmuxSession)
		_ = killCmd.Run()
	}

	// Stop the monitor goroutine.
	select {
	case <-task.stopMonitor:
	default:
		close(task.stopMonitor)
	}

	tm.mu.Lock()
	task.Status = TaskStatusStopped
	now := time.Now()
	task.FinishedAt = &now
	tm.mu.Unlock()

	return nil
}

// ListTasks returns info about all tasks.
func (tm *TaskManager) ListTasks() []TaskInfo {
	tm.mu.RLock()
	defer tm.mu.RUnlock()

	result := make([]TaskInfo, 0, len(tm.tasks))
	for _, t := range tm.tasks {
		result = append(result, TaskInfo{
			ID:          t.ID,
			Title:       t.Title,
			Description: t.Description,
			Status:      t.Status,
			CreatedAt:   t.CreatedAt,
			StartedAt:   t.StartedAt,
			FinishedAt:  t.FinishedAt,
		})
	}
	return result
}

// ContinueTask sends additional input to an active tmux session.
func (tm *TaskManager) ContinueTask(id, input string) error {
	tm.mu.RLock()
	task, ok := tm.tasks[id]
	tm.mu.RUnlock()
	if !ok {
		return fmt.Errorf("task %s not found", id)
	}

	if task.Status != TaskStatusRunning {
		return fmt.Errorf("task %s is not running (status: %s)", id, task.Status)
	}

	cmd := exec.Command("tmux", "send-keys", "-t", task.TmuxSession, input, "Enter")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("send input to tmux: %s: %w", string(out), err)
	}
	return nil
}

// GetTask returns a single task by ID.
func (tm *TaskManager) GetTask(id string) (*Task, bool) {
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	t, ok := tm.tasks[id]
	return t, ok
}
