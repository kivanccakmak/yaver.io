package main

// task_presentation.go is the runner -> Yaver surface presentation contract.
//
// Runner stdout is evidence, not a user interface. Codex, Claude Code and
// OpenCode each render an excellent local TUI because their renderer still
// knows which payload is assistant prose, progress, a tool call or a diff.
// Once those bytes are flattened into a PTY stream that meaning is gone. This
// contract preserves the meaning beside (never instead of) the lossless raw
// lane so every remote surface can show a calm human answer and keep the
// terminal transcript folded for diagnosis.

import (
	"os"
	"runtime"
	"strings"
	"time"
)

const (
	TaskPresentationSchema      = 1
	maxTaskPresentationMessages = 64
	maxTaskPresentationText     = 32 * 1024
	maxTaskPresentationTotal    = 64 * 1024
	maxTaskPresentationListText = 4 * 1024
)

// TaskPresentationMessage is a surface-safe semantic message. Kind is one of
// message, status, action_required, warning, error, tool or patch. Detailed
// command lines, paths, patches and runner dumps do not belong here; they ride
// command_* events or the raw stream.
type TaskPresentationMessage struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"`
	Role      string    `json:"role,omitempty"`
	Text      string    `json:"text"`
	Phase     string    `json:"phase,omitempty"`
	State     string    `json:"state,omitempty"`
	Runner    string    `json:"runner,omitempty"`
	Project   string    `json:"project,omitempty"`
	Machine   string    `json:"machine,omitempty"`
	Platform  string    `json:"platform,omitempty"`
	Surface   string    `json:"surface,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// TaskPresentationEvent rides task SSE. op=append extends the text of an
// existing message; op=upsert replaces it. A presentation_snapshot is replayed
// on every subscription, so a dropped live delta is self-healing.
type TaskPresentationEvent struct {
	Type    string                   `json:"type"`
	Schema  int                      `json:"schema"`
	Op      string                   `json:"op"`
	Seq     int64                    `json:"seq"`
	Message *TaskPresentationMessage `json:"message,omitempty"`
}

type taskPresentationInput struct {
	ID      string
	Kind    string
	Role    string
	Text    string
	Phase   string
	State   string
	Surface string
	Append  bool
}

func normalizePresentationKind(kind string) string {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "message", "status", "action_required", "warning", "error", "tool", "patch":
		return strings.ToLower(strings.TrimSpace(kind))
	default:
		return "status"
	}
}

func trimPresentationText(text string) string {
	if len(text) <= maxTaskPresentationText {
		return text
	}
	return "…" + text[len(text)-maxTaskPresentationText:]
}

// present records and streams one semantic update. It is safe to call from
// runner reader goroutines. Do not call it while holding tm.mu; terminal paths
// that already hold the lock use presentLocked and stream after unlocking.
func (tm *TaskManager) present(task *Task, in taskPresentationInput) {
	if tm == nil || task == nil || strings.TrimSpace(in.Text) == "" {
		return
	}
	tm.mu.Lock()
	ev := tm.presentLocked(task, in)
	// Token deltas can arrive hundreds of times per second; persist the
	// authoritative upsert/status boundaries, never each append fragment.
	if !in.Append {
		tm.persistAsync()
	}
	tm.mu.Unlock()
	if ev.Message != nil {
		emitTaskEvent(task, map[string]interface{}{
			"type": "presentation", "schema": ev.Schema, "op": ev.Op,
			"seq": ev.Seq, "message": ev.Message,
		})
	}
}

func (tm *TaskManager) presentLocked(task *Task, in taskPresentationInput) TaskPresentationEvent {
	now := time.Now()
	id := strings.TrimSpace(in.ID)
	if id == "" {
		id = task.ID + "-presentation-" + now.Format("150405.000000")
	}
	text := in.Text
	op := "upsert"
	idx := -1
	for i := range task.Presentation {
		if task.Presentation[i].ID == id {
			idx = i
			break
		}
	}
	if in.Append && idx >= 0 {
		text = task.Presentation[idx].Text + text
		op = "append"
	}
	text = trimPresentationText(text)
	host, _ := os.Hostname()
	createdAt := now
	if idx >= 0 {
		createdAt = task.Presentation[idx].CreatedAt
	}
	msg := TaskPresentationMessage{
		ID: id, Kind: normalizePresentationKind(in.Kind), Role: strings.TrimSpace(in.Role),
		Text: text, Phase: strings.TrimSpace(in.Phase), State: strings.TrimSpace(in.State),
		Runner: normalizeRunnerID(task.RunnerID), Project: strings.TrimSpace(task.ProjectName),
		Machine: host, Platform: runtime.GOOS + "/" + runtime.GOARCH,
		Surface: strings.TrimSpace(in.Surface), CreatedAt: createdAt, UpdatedAt: now,
	}
	if idx >= 0 {
		task.Presentation[idx] = msg
	} else {
		task.Presentation = append(task.Presentation, msg)
		if len(task.Presentation) > maxTaskPresentationMessages {
			task.Presentation = append([]TaskPresentationMessage(nil), task.Presentation[len(task.Presentation)-maxTaskPresentationMessages:]...)
		}
	}
	// Bound the persisted semantic lane as a whole, not just each row. Without
	// this, 64 valid 32 KB messages turn every task detail into a multi-megabyte
	// poll. Preserve the newest state and answer; lossless history remains in
	// Turns and the raw runner lane.
	for presentationTextBytes(task.Presentation) > maxTaskPresentationTotal && len(task.Presentation) > 1 {
		remove := 0
		if task.Presentation[remove].ID == id {
			remove = 1
		}
		task.Presentation = append(task.Presentation[:remove], task.Presentation[remove+1:]...)
	}
	task.PresentationSeq++
	// append events carry only the delta; snapshots and upserts carry the
	// complete text. This keeps token streaming O(n) while reconnect remains
	// authoritative.
	wire := msg
	if op == "append" {
		wire.Text = in.Text
	}
	return TaskPresentationEvent{Type: "presentation", Schema: TaskPresentationSchema, Op: op, Seq: task.PresentationSeq, Message: &wire}
}

func presentationTextBytes(messages []TaskPresentationMessage) int {
	total := 0
	for i := range messages {
		total += len(messages[i].Text)
	}
	return total
}

func taskRunningPresentation(task *Task) taskPresentationInput {
	runner := strings.TrimSpace(task.RunnerName)
	if runner == "" {
		runner = strings.TrimSpace(task.RunnerID)
	}
	if runner == "" {
		runner = "Coding runner"
	}
	project := strings.TrimSpace(task.ProjectName)
	text := runner + " is working"
	if project != "" {
		text += " on " + project
	}
	return taskPresentationInput{ID: task.ID + "-activity", Kind: "status", Text: text + ".", Phase: "coding", State: "running", Surface: task.LastSurface}
}

// taskPresentationSnapshot derives the activity row from authoritative task
// state at read time. This prevents a process that exits between its last SSE
// delta and persistence from leaving "is working" on a completed task.
func taskPresentationSnapshot(task *Task) []TaskPresentationMessage {
	if task == nil {
		return nil
	}
	out := append([]TaskPresentationMessage(nil), task.Presentation...)
	for i := range out {
		if out[i].ID != task.ID+"-activity" {
			continue
		}
		project := strings.TrimSpace(task.ProjectName)
		suffix := "."
		if project != "" {
			suffix = " on " + project + "."
		}
		switch task.Status {
		case TaskStatusFinished:
			out[i].Text, out[i].Phase, out[i].State = "Completed"+suffix, "complete", "completed"
		case TaskStatusReview:
			out[i].Text, out[i].Phase, out[i].State = "Ready for review"+suffix, "review", "review"
		case TaskStatusFailed:
			out[i].Text, out[i].Phase, out[i].State, out[i].Kind = "The task needs attention"+suffix, "blocked", "failed", "error"
		case TaskStatusStopped:
			out[i].Text, out[i].Phase, out[i].State = "Stopped"+suffix, "stopped", "stopped"
		case TaskStatusQueued:
			out[i].Text, out[i].Phase, out[i].State = "Waiting to start"+suffix, "queued", "queued"
		}
	}
	return out
}

// Lists refresh frequently and only need the newest human state plus newest
// assistant answer. Detail and SSE retain the bounded full semantic snapshot.
func taskPresentationListSnapshot(task *Task) []TaskPresentationMessage {
	all := taskPresentationSnapshot(task)
	if len(all) == 0 {
		return nil
	}
	selected := make([]TaskPresentationMessage, 0, 2)
	seen := map[string]bool{}
	for i := len(all) - 1; i >= 0 && len(selected) < 2; i-- {
		message := all[i]
		if message.Kind != "message" && message.Kind != "status" && message.Kind != "action_required" && message.Kind != "warning" && message.Kind != "error" {
			continue
		}
		group := "status"
		if message.Kind == "message" && message.Role == "assistant" {
			group = "assistant"
		}
		if seen[group] || (group == "status" && message.Kind == "message") {
			continue
		}
		seen[group] = true
		if len(message.Text) > maxTaskPresentationListText {
			message.Text = "…" + message.Text[len(message.Text)-maxTaskPresentationListText:]
		}
		selected = append(selected, message)
	}
	for left, right := 0, len(selected)-1; left < right; left, right = left+1, right-1 {
		selected[left], selected[right] = selected[right], selected[left]
	}
	return selected
}
