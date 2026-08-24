package main

import (
	"errors"
	"testing"
	"time"
)

func completedContinuationTask(id, runnerID, sessionID, workDir string) *Task {
	runner := GetRunnerConfig(runnerID)
	// echo makes the test exercise the real resume spawn without spending a
	// model turn. resumeTransform still builds each runner's production argv.
	runner.Command = "/bin/echo"
	return &Task{
		ID:          id,
		Title:       "one conversation",
		Description: "first turn",
		Status:      TaskStatusReview,
		RunnerID:    runnerID,
		SessionID:   sessionID,
		WorkDir:     workDir,
		CreatedAt:   time.Now(),
		runner:      runner,
	}
}

func TestCompletedFollowUpKeepsTaskAndRunnerSessionForEveryRunner(t *testing.T) {
	for _, tc := range []struct {
		runner, session string
	}{
		{"claude", "11111111-1111-4111-8111-111111111111"},
		{"codex", "22222222-2222-4222-8222-222222222222"},
		{"opencode", "ses_exact_task_session"},
	} {
		t.Run(tc.runner, func(t *testing.T) {
			t.Setenv(taskTmuxEnvVar, "0")
			tm := NewTaskManager(t.TempDir(), nil, defaultTestRunner())
			task := completedContinuationTask("same-task-"+tc.runner, tc.runner, tc.session, t.TempDir())
			tm.tasks[task.ID] = task

			got, err := tm.ResumeTaskWithOptions(task.ID, "follow up", nil, TaskResumeOptions{})
			if err != nil {
				t.Fatalf("continue failed: %v", err)
			}
			if got.ID != task.ID || len(tm.tasks) != 1 {
				t.Fatalf("follow-up created another task: got=%q tasks=%d", got.ID, len(tm.tasks))
			}
			if got.SessionID != tc.session {
				t.Fatalf("runner session changed: got=%q want=%q", got.SessionID, tc.session)
			}
			select {
			case <-got.doneCh:
			case <-time.After(5 * time.Second):
				t.Fatal("fake resumed turn did not finish")
			}
		})
	}
}

func TestFollowUpRefusesColdOrDifferentRunnerSession(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultTestRunner())
	task := completedContinuationTask("same-task", "codex", "", t.TempDir())
	tm.tasks[task.ID] = task

	_, err := tm.ResumeTaskWithOptions(task.ID, "follow up", nil, TaskResumeOptions{})
	var conflict *TaskContinuationConflict
	if !errors.As(err, &conflict) || conflict.Code != "runner_session_unavailable" {
		t.Fatalf("missing session conflict = %#v, want runner_session_unavailable", err)
	}
	if task.Status != TaskStatusReview || len(task.Turns) != 0 || len(tm.tasks) != 1 {
		t.Fatalf("refused follow-up mutated task: status=%s turns=%d tasks=%d", task.Status, len(task.Turns), len(tm.tasks))
	}

	task.SessionID = "33333333-3333-4333-8333-333333333333"
	_, err = tm.ResumeTaskWithOptions(task.ID, "switch", nil, TaskResumeOptions{RunnerID: "claude"})
	if !errors.As(err, &conflict) || conflict.Code != "task_runner_session_mismatch" {
		t.Fatalf("runner switch conflict = %#v, want task_runner_session_mismatch", err)
	}
	if task.RunnerID != "codex" || task.SessionID != "33333333-3333-4333-8333-333333333333" || len(tm.tasks) != 1 {
		t.Fatalf("runner switch mutated identity: runner=%q session=%q tasks=%d", task.RunnerID, task.SessionID, len(tm.tasks))
	}
}

func TestTaskExecutionIdentityCarriesRunnerAndTmuxNamespaces(t *testing.T) {
	task := completedContinuationTask("task-identity", "opencode", "ses_exact", t.TempDir())
	task.TmuxSession = "yaver-task-task-identit-opencode"
	task.TmuxSessionID = "$7"
	task.TmuxWindowIndex = "2"
	task.TmuxWindowName = "yaver-task-task-identit"
	task.TmuxPaneIndex = "0"
	task.TmuxPaneID = "%19"

	tm := NewTaskManager(t.TempDir(), nil, defaultTestRunner())
	tm.DeviceID = "box-test"
	task.YaverSessionID = "ys_test"
	task.RunnerName = "OpenCode"
	task.SessionStartedFrom = "vibing"
	task.StartedFromSurface = "mobile"
	got := tm.taskExecutionIdentity(task)
	if !got.Resumable || got.RunnerSessionID != "ses_exact" || got.TmuxSessionID != "$7" || got.TmuxPaneID != "%19" {
		t.Fatalf("execution identity lost a namespace: %+v", got)
	}
	if got.YaverSessionID != "ys_test" || got.RemoteBoxID != "box-test" || got.RunnerName != "OpenCode" || got.StartedFrom != "vibing" || got.StartedFromSurface != "mobile" {
		t.Fatalf("execution identity lost Yaver session provenance: %+v", got)
	}
}
