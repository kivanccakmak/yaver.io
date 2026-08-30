package main

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestShellQuoteRoundTrip(t *testing.T) {
	cases := []string{
		`hello`,
		`hello world`,
		`it's me`,
		`'single'`,
		`$HOME`,
		`a"b`,
		`a;b`,
		``,
	}
	for _, c := range cases {
		quoted := shellQuoteStrict(c)
		// `sh -c 'printf %s '"$quoted"` would re-print c verbatim. We
		// invoke sh and confirm the output equals the input.
		out, err := exec.Command("sh", "-c", "printf %s "+quoted).Output()
		if err != nil {
			t.Fatalf("shell exec for %q (quoted=%s) failed: %v", c, quoted, err)
		}
		if string(out) != c {
			t.Fatalf("roundtrip mismatch: input=%q quoted=%s got=%q", c, quoted, string(out))
		}
	}
}

func TestShellJoinPreservesArgBoundaries(t *testing.T) {
	args := []string{"claude", "-p", "hello world", "--model", "opus"}
	joined := shellJoin(args)
	// `sh -c 'printf "[%s]" arg1 arg2 ...'` lets us see how sh tokenized.
	out, err := exec.Command("sh", "-c", `printf "[%s]" `+joined).Output()
	if err != nil {
		t.Fatalf("sh -c failed: %v", err)
	}
	want := `[claude][-p][hello world][--model][opus]`
	if string(out) != want {
		t.Fatalf("shellJoin lost arg boundaries: want %q got %q (joined=%s)", want, string(out), joined)
	}
}

func TestShortTaskKeyClampAndSanitize(t *testing.T) {
	cases := map[string]string{
		"abc":              "abc",
		"abcdefghijklmno":  "abcdefghijkl", // 12-char clamp
		"task/with/slash":  "task-with-sl", // sanitized then clamped
		"weird!@#$%^&*()_": "weird-------",
		"keep_under-score": "keep_under-s",
	}
	for in, want := range cases {
		got := shortTaskKey(in)
		if got != want {
			t.Errorf("shortTaskKey(%q): want %q got %q", in, want, got)
		}
		if len(got) > 12 {
			t.Errorf("shortTaskKey(%q) = %q exceeds 12 chars", in, got)
		}
	}
}

func TestTmuxRunnerLegacyOverrideOffByDefault(t *testing.T) {
	// Empty means there is no shared-session override. Automatic per-task tmux
	// selection is tested separately and intentionally defaults on.
	t.Setenv(tmuxRunnerEnvVar, "")
	if got := tmuxRunnerReady(); got != "" {
		t.Fatalf("tmuxRunnerReady() with empty env: want empty, got %q", got)
	}
}

func TestAutomaticTaskTmuxSessionNamesRunner(t *testing.T) {
	if got, want := automaticTaskTmuxSessionName("fe2ebda2", "codex"), "yaver-task-fe2ebda2-codex"; got != want {
		t.Fatalf("automaticTaskTmuxSessionName = %q, want %q", got, want)
	}
	if got := automaticTaskTmuxSessionName("abc/def", "claude-code"); got != "yaver-task-abc-def-claude" {
		t.Fatalf("automaticTaskTmuxSessionName canonicalization = %q", got)
	}
}

func TestTaskOwnedTmuxTurnStaysUnresolvedUntilExplicitLifecycleAction(t *testing.T) {
	task := &Task{
		ID:          "recoverable-turn",
		Source:      "cli",
		RunnerID:    "codex",
		TmuxSession: automaticTaskTmuxSessionName("recoverable-turn", "codex"),
	}
	if got := taskSuccessStatus(task); got != TaskStatusReview {
		t.Fatalf("successful task-owned turn status = %s, want review", got)
	}
	if got := taskUnresolvedStatus(task, TaskStatusFailed); got != TaskStatusReview {
		t.Fatalf("failed task-owned turn status = %s, want review", got)
	}

	// A direct subprocess has no recoverable seat, so its failure remains a
	// failure and does not get hidden in Review.
	direct := &Task{ID: "direct", RunnerID: "codex"}
	if got := taskUnresolvedStatus(direct, TaskStatusFailed); got != TaskStatusFailed {
		t.Fatalf("direct task failure status = %s, want failed", got)
	}
}

func TestStartupRecoversIdleTaskOwnedTmuxSeatAsReview(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	taskID := "startup-seat-" + shortTaskKey(t.Name())
	session := automaticTaskTmuxSessionName(taskID, "codex")
	t.Logf("test tmux session: %s", session)
	_ = exec.Command(tmuxCmdName(), "kill-session", "-t", session).Run()
	t.Cleanup(func() { _ = exec.Command(tmuxCmdName(), "kill-session", "-t", session).Run() })
	if out, err := exec.Command(tmuxCmdName(), "new-session", "-d", "-s", session).CombinedOutput(); err != nil {
		t.Fatalf("create idle task-owned session: %v: %s", err, out)
	}
	pane := getActivePaneIdentity(session)
	if pane.PaneID == "" {
		t.Fatal("task-owned session has no pane")
	}

	manager := NewTaskManager(t.TempDir(), nil, defaultTestRunner())
	manager.mu.Lock()
	manager.tasks[taskID] = &Task{
		ID: taskID, RunnerID: "codex", Status: TaskStatusRunning,
		TmuxSession: session, TmuxSessionID: pane.SessionID, TmuxPaneID: pane.PaneID,
	}
	manager.mu.Unlock()
	tmuxManager := NewTmuxManager(manager)
	if tmuxManager == nil {
		t.Fatal("tmux manager unavailable")
	}
	defer tmuxManager.Shutdown()
	tmuxManager.ReAdoptOnStartup()

	manager.mu.RLock()
	status := manager.tasks[taskID].Status
	manager.mu.RUnlock()
	if status != TaskStatusReview {
		t.Fatalf("recovered idle task-owned seat status = %s, want review", status)
	}
	if !tmuxSessionExists(session) {
		t.Fatal("startup reconciliation destroyed the recoverable tmux seat")
	}
}

func TestTaskTmuxExplicitOptOut(t *testing.T) {
	t.Setenv(taskTmuxEnvVar, "0")
	if taskTmuxEnabled("codex") {
		t.Fatal("YAVER_TASK_TMUX=0 must disable automatic task tmux")
	}
}

func TestTmuxRunnerReadyAbsentSession(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed; nothing to assert")
	}
	t.Setenv(tmuxRunnerEnvVar, "yaver-test-no-such-session-"+os.Getenv("USER"))
	if got := tmuxRunnerReady(); got != "" {
		t.Fatalf("tmuxRunnerReady() for nonexistent session: want empty, got %q", got)
	}
}

func TestTmuxRunnerEligibleClaudeOnly(t *testing.T) {
	for _, ok := range []string{"claude", "Claude", "CLAUDE-CODE", "claude-code", "opencode", "OpenCode", "codex", "Codex"} {
		if !tmuxRunnerEligible(ok) {
			t.Errorf("expected %q to be eligible", ok)
		}
	}
	for _, no := range []string{"", "claude2", "yaver"} {
		if tmuxRunnerEligible(no) {
			t.Errorf("expected %q to be ineligible", no)
		}
	}
}

func TestBuildTmuxRunnerCommandShape(t *testing.T) {
	cmd, env := buildTmuxRunnerCommand(
		context.Background(),
		tmuxRunnerTarget{Session: "yaver-claude"},
		"task-abc-def-ghi-jkl",
		"claude",
		"/tmp/project",
		"claude",
		[]string{"-p", "say hi"},
		[]string{"CLAUDE_CONFIG_DIR=/tmp/yaver-claude"},
	)
	if cmd.Args[0] != "sh" || cmd.Args[1] != "-c" {
		t.Fatalf("expected sh -c invocation, got %v", cmd.Args)
	}
	if !strings.Contains(cmd.Args[2], "tmux new-window") {
		t.Fatal("script body missing tmux new-window")
	}
	if !strings.Contains(cmd.Args[2], "alternate-screen off") {
		t.Fatal("script body must disable tmux alternate-screen for inspectable scrollback")
	}
	if !strings.Contains(cmd.Args[2], "tmux send-keys") {
		t.Fatal("script body must send the runner command after window options are applied")
	}
	if !strings.Contains(cmd.Args[2], "tmux wait-for") {
		t.Fatal("script body missing tmux wait-for")
	}
	if !strings.Contains(cmd.Args[2], "trap cleanup") {
		t.Fatal("script body missing cleanup trap (would leak panes on cancel)")
	}
	if strings.Index(cmd.Args[2], "tmux pipe-pane") > strings.Index(cmd.Args[2], "tmux send-keys") {
		t.Fatal("pipe-pane must be installed before runner launch or fast output can be lost")
	}
	wantInner := "'env' 'CLAUDE_CONFIG_DIR=/tmp/yaver-claude' 'claude' '-p' 'say hi'"
	var sawInner, sawSession bool
	for _, kv := range env {
		if kv == "YAVER_TMUX_SESSION=yaver-claude" {
			sawSession = true
		}
		if strings.HasPrefix(kv, "YAVER_TMUX_INNER=") && strings.Contains(kv, wantInner) {
			sawInner = true
		}
	}
	if !sawSession {
		t.Errorf("env missing YAVER_TMUX_SESSION: %v", env)
	}
	if !sawInner {
		t.Errorf("env missing properly-quoted YAVER_TMUX_INNER (want contains %q): %v", wantInner, env)
	}
}

func TestBuildAutomaticTmuxRunnerCreatesExactTaskSession(t *testing.T) {
	cmd, env := buildTmuxRunnerCommand(
		context.Background(),
		tmuxRunnerTarget{Session: "yaver-task-fe2ebda2-codex", CreateSession: true},
		"fe2ebda2", "codex", "/tmp/project", "codex", []string{"exec", "hello"}, nil,
	)
	if !strings.Contains(cmd.Args[2], "tmux new-session") {
		t.Fatalf("automatic wrapper must own an exact session: %s", cmd.Args[2])
	}
	if strings.Contains(cmd.Args[2], `tmux kill-session -t "$SESSION"`) ||
		!strings.Contains(cmd.Args[2], `tmux pipe-pane -t "$TARGET"`) {
		t.Fatal("the wrapper must preserve the task-owned seat between review turns; the task lifecycle owns terminal cleanup")
	}
	if strings.Contains(cmd.Args[2], `tmux kill-session -t "$SESSION" 2>/dev/null || true
  tmux new-session`) {
		t.Fatal("a follow-up must reuse the existing task session, not kill and recreate it")
	}
	want := map[string]bool{
		"YAVER_TMUX_SESSION=yaver-task-fe2ebda2-codex": false,
		"YAVER_TMUX_CREATE_SESSION=1":                  false,
		"YAVER_TMUX_RUNNER_ID=codex":                   false,
		"YAVER_TMUX_TASK_ID=fe2ebda2":                  false,
		"YAVER_TMUX_CWD=/tmp/project":                  false,
	}
	for _, kv := range env {
		if _, ok := want[kv]; ok {
			want[kv] = true
		}
	}
	for kv, seen := range want {
		if !seen {
			t.Errorf("automatic wrapper env missing %q: %v", kv, env)
		}
	}
}

func TestCompleteTaskClosesExactTaskOwnedTmuxSeat(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	taskID := "complete-seat-" + shortTaskKey(t.Name())
	session := automaticTaskTmuxSessionName(taskID, "codex")
	t.Logf("test tmux session: %s", session)
	_ = exec.Command(tmuxCmdName(), "kill-session", "-t", session).Run()
	t.Cleanup(func() { _ = exec.Command(tmuxCmdName(), "kill-session", "-t", session).Run() })
	if out, err := exec.Command(tmuxCmdName(), "new-session", "-d", "-s", session, "sleep", "60").CombinedOutput(); err != nil {
		t.Fatalf("create task-owned session: %v: %s", err, out)
	}

	manager := NewTaskManager(t.TempDir(), nil, defaultTestRunner())
	manager.mu.Lock()
	manager.tasks[taskID] = &Task{
		ID: taskID, RunnerID: "codex", Status: TaskStatusReview,
		TmuxSession: session,
	}
	manager.mu.Unlock()

	// A review task keeps its seat until the user makes this explicit gesture.
	if !tmuxSessionExists(session) {
		t.Fatal("review task lost its reusable tmux seat before completion")
	}
	if err := manager.CompleteTask(taskID); err != nil {
		t.Fatalf("complete task: %v", err)
	}
	if tmuxSessionExists(session) {
		t.Fatalf("completed task left its tmux session alive: %s", session)
	}
	manager.mu.RLock()
	status := manager.tasks[taskID].Status
	manager.mu.RUnlock()
	if status != TaskStatusFinished {
		t.Fatalf("completed task status = %s, want %s", status, TaskStatusFinished)
	}
}

func TestUntrackedRunnerPanesBecomeTasksWithoutDuplicatingOwnedSeats(t *testing.T) {
	manager := NewTaskManager(t.TempDir(), nil, defaultTestRunner())
	manager.mu.Lock()
	manager.tasks["owned"] = &Task{ID: "owned", TmuxPaneID: "%2", Status: TaskStatusReview}
	manager.mu.Unlock()
	panes := []VibePane{
		{PaneID: "%1", SessionName: "external", Agent: "codex", AgentConfirmed: true},
		{PaneID: "%2", SessionName: "owned", Agent: "claude", AgentConfirmed: true},
		{PaneID: "%3", SessionName: "shell", Agent: "shell", AgentConfirmed: false},
	}
	got := untrackedRunnerPanes(manager, panes)
	if len(got) != 1 || got[0].PaneID != "%1" {
		t.Fatalf("untracked runner panes = %+v, want only %%1", got)
	}
}

func TestAutomaticTmuxRunnerKeepsExactSeatAcrossTurns(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	taskID := "seat-test-" + shortTaskKey(t.Name())
	session := automaticTaskTmuxSessionName(taskID, "codex")
	// Exact test-owned target, listed before the destructive cleanup.
	t.Logf("test tmux session: %s", session)
	_ = exec.Command(tmuxCmdName(), "kill-session", "-t", session).Run()
	t.Cleanup(func() { _ = exec.Command(tmuxCmdName(), "kill-session", "-t", session).Run() })

	runTurn := func(text string) tmuxPaneIdentity {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cmd, additions := buildTmuxRunnerCommand(
			ctx,
			tmuxRunnerTarget{Session: session, CreateSession: true},
			taskID, "codex", t.TempDir(), "/bin/sh", []string{"-c", "printf '%s\\n' " + shellQuoteStrict(text)}, nil,
		)
		cmd.Env = append(os.Environ(), additions...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("turn failed: %v: %s", err, out)
		}
		pane := waitForTmuxTaskPane(session, taskID, time.Second)
		if pane.SessionID == "" || pane.PaneID == "" {
			t.Fatalf("turn did not leave an addressable tmux seat: %+v", pane)
		}
		return pane
	}

	first := runTurn("first")
	second := runTurn("follow-up")
	if first.SessionID != second.SessionID || first.PaneID != second.PaneID || first.WindowIndex != second.WindowIndex {
		t.Fatalf("follow-up changed tmux seat: first=%+v second=%+v", first, second)
	}

	manager := NewTaskManager(t.TempDir(), nil, defaultTestRunner())
	manager.mu.Lock()
	manager.tasks[taskID] = &Task{
		ID: taskID, RunnerID: "codex", Status: TaskStatusFinished,
		TmuxSession: session, TmuxSessionID: second.SessionID, TmuxPaneID: second.PaneID,
	}
	manager.mu.Unlock()
	if err := manager.DeleteTask(taskID); err != nil {
		t.Fatalf("delete task: %v", err)
	}
	if tmuxSessionExists(session) {
		t.Fatalf("deleting task left its tmux session alive: %s", session)
	}
}
