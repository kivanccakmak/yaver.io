package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	taskTransportOpenCodeACP = "acp-native"
	taskTransportCLI         = "cli-pty"
)

// Test seam around ACP subprocess creation. Production uses the same resolver
// as ACP auth probes and doctor.
var newACPTaskClient = newACPClientForRunner

// shouldUseOpenCodeACP is intentionally conservative. Features without ACP
// parity stay on the established CLI path instead of being silently ignored.
func shouldUseOpenCodeACP(task *Task, runner RunnerConfig, effectiveModel string, rawRunnerCommand bool) (bool, string) {
	if normalizeRunnerID(runner.RunnerID) != "opencode" {
		return false, "runner has no native ACP task lane"
	}
	if strings.TrimSpace(os.Getenv("YAVER_OPENCODE_ACP")) == "0" {
		return false, "disabled by YAVER_OPENCODE_ACP=0"
	}
	if task == nil {
		return false, "missing task"
	}
	if rawRunnerCommand {
		return false, "runner-native commands require the CLI lane"
	}
	if task.ResumeLast || task.SessionID != "" {
		return false, "resume remains on the CLI lane"
	}
	if task.IsAdopted || task.TmuxSession != "" || tmuxRunnerReady() != "" {
		return false, "tmux execution requires the CLI lane"
	}
	if strings.TrimSpace(effectiveModel) != "" || strings.TrimSpace(runner.Mode) != "" {
		return false, "pinned model or mode awaits ACP config-option parity"
	}
	if len(task.ImagePaths) != 0 {
		return false, "attachments await ACP task parity"
	}
	return true, "native OpenCode ACP is eligible"
}

// tryStartOpenCodeACP performs only reversible startup synchronously. Before
// Prompt begins, falling back cannot execute a user's request twice.
func (tm *TaskManager) tryStartOpenCodeACP(ctx context.Context, task *Task, prompt, taskDir string) (bool, error) {
	var outputMu sync.Mutex
	var output strings.Builder
	output.WriteString(task.Output)

	client, err := newACPTaskClient("opencode", taskDir, acpClientOptions{
		Env: taskEnv(task),
		OnNotify: func(method string, params json.RawMessage) {
			if method != "session/update" {
				return
			}
			var update acpSessionUpdate
			if err := json.Unmarshal(params, &update); err != nil {
				log.Printf("[task %s] ignoring malformed ACP session/update: %v", task.ID, err)
				return
			}
			emitTaskEvent(task, map[string]interface{}{
				"type": "runner_event", "schema": 1,
				"runner": "opencode", "transport": taskTransportOpenCodeACP,
				"event": update.Update.SessionUpdate, "messageId": update.Update.MessageID,
			})
			if update.Update.SessionUpdate != "agent_message_chunk" {
				return
			}
			for _, block := range update.Update.Content {
				if block.Type != "text" || block.Text == "" {
					continue
				}
				outputMu.Lock()
				tm.emitRaw(task, []byte(block.Text))
				tm.emit(task, &output, block.Text)
				outputMu.Unlock()
			}
		},
	})
	if err != nil {
		return false, fmt.Errorf("spawn: %w", err)
	}

	initCtx, initCancel := context.WithTimeout(ctx, 45*time.Second)
	_, err = client.Initialize(initCtx)
	initCancel()
	if err != nil {
		client.Close()
		return false, fmt.Errorf("initialize: %w", err)
	}

	mcpServers := acpMCPServersForTask(findYaverBinary(), enabledExternalServersFor(task.MCPServers), task.IncludeYaverMcp)
	sessionCtx, sessionCancel := context.WithTimeout(ctx, 30*time.Second)
	sessionID, _, err := client.NewSession(sessionCtx, taskDir, mcpServers)
	sessionCancel()
	if err != nil {
		client.Close()
		return false, fmt.Errorf("session/new: %w", err)
	}

	now := time.Now()
	task.SessionID = sessionID
	task.Transport = taskTransportOpenCodeACP
	task.StartedAt = &now
	task.Status = TaskStatusRunning
	emitTaskEvent(task, map[string]interface{}{
		"type": "runner_transport", "schema": 1,
		"runner": "opencode", "transport": taskTransportOpenCodeACP,
	})
	go tm.runOpenCodeACPPrompt(ctx, client, task, sessionID, prompt)
	return true, nil
}

func (tm *TaskManager) runOpenCodeACPPrompt(ctx context.Context, client *acpClient, task *Task, sessionID, prompt string) {
	result, promptErr := client.Prompt(ctx, sessionID, []acpContentBlock{acpTextBlock(prompt)})
	client.Close()

	finishNow := time.Now()
	tm.mu.Lock()
	task.cancel = nil
	task.FinishedAt = &finishNow
	if result != nil && result.Usage != nil {
		task.InputTokens = result.Usage.InputTokens
		task.OutputTokens = result.Usage.OutputTokens
	}
	task.ResultText = strings.TrimSpace(task.Output)

	cancelled := false
	switch {
	case errors.Is(promptErr, context.Canceled) || errors.Is(ctx.Err(), context.Canceled):
		// Publish the stopped state before doneCh so an SSE consumer cannot
		// observe done while the snapshot still says running. StopTask performs
		// the persistence/callback after its wait returns.
		task.Status = TaskStatusStopped
		cancelled = true
	case promptErr != nil:
		task.Status = TaskStatusFailed
		if task.ResultText == "" {
			task.ResultText = "OpenCode ACP stopped before producing a reply: " + promptErr.Error()
			task.Output = task.ResultText
		}
		log.Printf("[task %s] OpenCode ACP prompt failed: %v", task.ID, promptErr)
	case isEmptyRunnerReply(task.Output, task.ResultText):
		task.Status = TaskStatusFailed
		task.ResultText = "OpenCode ACP completed without producing a reply. Retry on the CLI compatibility lane or run Yaver Doctor to probe the runner."
		task.Output = task.ResultText
	default:
		task.Status = taskSuccessStatus(task)
	}
	if cancelled {
		tm.mu.Unlock()
		closeTaskStream(task.outputCh)
		closeTaskDone(task.doneCh)
		return
	}

	ObserveRunnerAuthFromOutput(task.RunnerID, task.Output+"\n"+task.ResultText, string(task.Status))
	task.Failure = diagnoseTaskFailure(task, finishNow)
	if task.ResultText != "" {
		task.Turns = append(task.Turns, ConversationTurn{Role: "assistant", Content: task.ResultText, Timestamp: finishNow})
	}
	if (task.Status == TaskStatusReview || task.Status == TaskStatusFinished) && len(task.PendingFollowUps) > 0 {
		next := task.PendingFollowUps[0]
		task.PendingFollowUps = task.PendingFollowUps[1:]
		oldOutputCh := task.outputCh
		oldDoneCh := task.doneCh
		task.Turns = append(task.Turns, ConversationTurn{Role: "user", Content: next.Input, Timestamp: time.Now()})
		if len(next.Images) > 0 {
			task.ImagePaths = append(task.ImagePaths, saveImages(task.ID, next.Images)...)
		}
		if runnerID := normalizeRunnerID(next.Options.RunnerID); runnerID != "" {
			previousRunner := normalizeRunnerID(task.RunnerID)
			nextRunner := GetRunnerConfig(runnerID)
			task.runner = nextRunner
			task.RunnerID = nextRunner.RunnerID
			if nextRunner.RunnerID != previousRunner {
				task.SessionID = ""
			}
		}
		if model := strings.TrimSpace(next.Options.Model); model != "" {
			task.Model = model
		}
		if mode := strings.TrimSpace(next.Options.Mode); mode != "" {
			nextRunner := task.runner
			if nextRunner.Command == "" {
				nextRunner = tm.runner
			}
			nextRunner.Mode = mode
			task.runner = nextRunner
		}
		task.Output = ""
		task.RawOutput = ""
		task.ResultText = ""
		task.FinishedAt = nil
		task.Status = TaskStatusQueued
		task.outputCh = make(chan string, 512)
		task.rawOutputCh = make(chan []byte, 256)
		task.eventCh = make(chan map[string]interface{}, 32)
		task.doneCh = make(chan struct{})
		tm.persist()
		tm.mu.Unlock()

		closeTaskStream(oldOutputCh)
		closeTaskDone(oldDoneCh)
		if err := tm.startResume(task, next.Input); err != nil {
			tm.mu.Lock()
			task.Status = TaskStatusFailed
			now := time.Now()
			task.FinishedAt = &now
			task.ResultText = "Could not continue task on the CLI compatibility lane: " + err.Error()
			task.Output = task.ResultText
			tm.persist()
			tm.fireTaskDone(task)
			tm.mu.Unlock()
			closeTaskStream(task.outputCh)
			closeTaskDone(task.doneCh)
		}
		return
	}

	if tm.ConvexURL != "" && task.StartedAt != nil && task.FinishedAt != nil {
		duration := task.FinishedAt.Sub(*task.StartedAt).Seconds()
		startMs := task.StartedAt.UnixMilli()
		finishMs := task.FinishedAt.UnixMilli()
		runnerName, model, source, taskID := task.runner.Name, task.Model, task.Source, task.ID
		go func() {
			if err := ReportRunnerUsage(tm.ConvexURL, tm.AuthToken, tm.DeviceID, taskID, runnerName, model, source, duration, startMs, finishMs); err != nil {
				log.Printf("[usage] failed to report ACP task: %v", err)
			}
		}()
	}
	tm.persist()
	tm.fireTaskDone(task)
	tm.maybeProposeSchedule(task)
	// Session persistence runs outside the task lock, so hand it an immutable
	// snapshot. Stop/retry APIs may mutate the live task immediately after the
	// done event; reading that pointer asynchronously is a data race and can
	// write a history file with a mixed terminal state.
	sessionTask := *task
	sessionTask.Turns = append([]ConversationTurn(nil), task.Turns...)
	runnerName := task.runner.Name
	workDir := tm.effectiveTaskWorkDir(task)
	tm.mu.Unlock()

	go saveSessionFile(&sessionTask, runnerName, workDir)
	closeTaskStream(task.outputCh)
	closeTaskDone(task.doneCh)
}

func closeTaskStream(ch chan string) {
	if ch == nil {
		return
	}
	defer func() { _ = recover() }()
	close(ch)
}

func closeTaskDone(ch chan struct{}) {
	if ch == nil {
		return
	}
	defer func() { _ = recover() }()
	close(ch)
}
