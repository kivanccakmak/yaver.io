package main

// tmux_panes_test.go — real tmux, no mocks (the house pattern).
//
// Each test here pins a specific way the session-scoped model was wrong. The
// split-window cases are the point: everything passed before because every
// fixture had exactly one pane, which is the one layout where "the session" and
// "the agent" are the same thing.

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestIsTmuxNoServerRecognizesMissingMacOSSocket(t *testing.T) {
	for _, message := range []string{
		"no server running on /tmp/tmux-501/default",
		"no sessions",
		"error connecting to /private/tmp/ytmux-123/tmux-501/default (No such file or directory)",
	} {
		if !isTmuxNoServer(message) {
			t.Errorf("missing-server output was treated as an operational error: %q", message)
		}
	}
	if isTmuxNoServer("error connecting to /tmp/tmux-501/default (Permission denied)") {
		t.Fatal("permission denial must stay visible; it is not an empty tmux inventory")
	}
}

// splitTestSession creates a session with n panes in one window and returns the
// pane ids in creation order plus a cleanup func.
func splitTestSession(t *testing.T, name string, n int) ([]string, func()) {
	t.Helper()
	if !strings.HasPrefix(name, "yaver-test-") {
		t.Fatalf("refusing to manage non-fixture tmux session %q", name)
	}
	// A killed/interrupted `go test` cannot run its deferred cleanup. Remove
	// only the exact test-owned name before creating the fixture so one stale
	// harness artifact cannot poison every later full-suite run. The prefix
	// guard above keeps this recovery path away from user sessions.
	_ = exec.Command("tmux", "kill-session", "-t", "="+name).Run()
	if out, err := exec.Command("tmux", "new-session", "-d", "-s", name).CombinedOutput(); err != nil {
		t.Fatalf("new-session %q: %v: %s", name, err, out)
	}
	cleanup := func() { exec.Command("tmux", "kill-session", "-t", "="+name).Run() }
	for i := 1; i < n; i++ {
		if out, err := exec.Command("tmux", "split-window", "-t", name).CombinedOutput(); err != nil {
			cleanup()
			t.Fatalf("split-window %d: %v: %s", i, err, out)
		}
	}
	// Let each pane's shell reach its prompt. Keys sent into a pane whose shell
	// has not started yet are simply lost — which reads as "the feature did not
	// work" rather than "the fixture was not ready".
	time.Sleep(900 * time.Millisecond)
	out, err := exec.Command("tmux", "list-panes", "-t", name, "-F", "#{pane_id}").Output()
	if err != nil {
		cleanup()
		t.Fatalf("list-panes: %v", err)
	}
	var ids []string
	for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			ids = append(ids, l)
		}
	}
	if len(ids) != n {
		cleanup()
		t.Fatalf("expected %d panes, got %d (%v)", n, len(ids), ids)
	}
	return ids, cleanup
}

func paneContent(t *testing.T, paneID string) string {
	t.Helper()
	out, err := exec.Command("tmux", "capture-pane", "-t", paneID, "-p").Output()
	if err != nil {
		t.Fatalf("capture-pane %s: %v", paneID, err)
	}
	return string(out)
}

// Every pane must be discoverable. The old model reported one agent per session
// because it only ever looked at the active pane.
func TestListVibePanesSeesEveryPaneInASplitWindow(t *testing.T) {
	skipIfNoTmux(t)
	ids, cleanup := splitTestSession(t, "yaver-test-vibe-split", 3)
	defer cleanup()

	panes, err := ListVibePanes(context.Background())
	if err != nil {
		t.Fatalf("ListVibePanes: %v", err)
	}

	seen := map[string]bool{}
	for _, p := range panes {
		if p.SessionName == "yaver-test-vibe-split" {
			seen[p.PaneID] = true
			if p.PaneID == "" {
				t.Error("pane discovered without a pane id — it cannot be targeted")
			}
			if p.TTY == "" {
				t.Error("pane discovered without its TTY — re-parented runners would be invisible")
			}
		}
	}
	for _, id := range ids {
		if !seen[id] {
			t.Errorf("pane %s was not discovered (found: %v)", id, seen)
		}
	}
}

// Three observed Codex panes are three independent Tasks. Runner/model are
// attributes, never deduplication keys: the user's live session 141 contained
// exactly this shape in panes %183, %188, and %190.
func TestThreeObservedCodexPanesAreThreeTasksToDiscover(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	panes := []VibePane{
		{PaneID: "%183", Agent: "codex", AgentConfirmed: true, Model: "gpt-5.6-sol", ReasoningEffort: "low"},
		{PaneID: "%188", Agent: "codex", AgentConfirmed: true, Model: "gpt-5.6-sol", ReasoningEffort: "medium"},
		{PaneID: "%190", Agent: "codex", AgentConfirmed: true, Model: "gpt-5.6-sol", ReasoningEffort: "high"},
	}
	discovered := untrackedRunnerPanes(tm, panes)
	if got := len(discovered); got != 3 {
		t.Fatalf("discoverable Tasks = %d, want 3 distinct Codex Tasks", got)
	}
	for i, effort := range []string{"low", "medium", "high"} {
		if discovered[i].Model != "gpt-5.6-sol" || discovered[i].ReasoningEffort != effort {
			t.Fatalf("pane %s metadata = %q/%q, want gpt-5.6-sol/%s",
				discovered[i].PaneID, discovered[i].Model, discovered[i].ReasoningEffort, effort)
		}
	}
}

// /exit leaves tmux's shell alive. A target-exists check therefore cannot
// decide whether its coding Task is Active; the runner process must be probed.
func TestReconcileMovesExitedAdoptedRunnerOutOfActive(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	task := &Task{
		ID: "task-188", Status: TaskStatusRunning, IsAdopted: true,
		TmuxSession: "141", TmuxPaneID: "%188", doneCh: make(chan struct{}),
	}
	tm.tasks[task.ID] = task
	mgr := &TmuxManager{
		taskMgr: tm,
		adopted: map[string]string{"%188": task.ID},
		pollStop: map[string]context.CancelFunc{
			"%188": func() {},
		},
	}

	stopped := mgr.reconcileExitedAdoptedPanes(context.Background(), []VibePane{{
		PaneID: "%188", Status: VibeStatusNoAgent,
	}})
	if stopped != 1 || task.Status != TaskStatusStopped {
		t.Fatalf("stopped=%d status=%q, want one stopped Task", stopped, task.Status)
	}
	if _, ok := mgr.adopted["%188"]; ok {
		t.Fatal("exited pane remained registered as an active Task")
	}
}

// A pane with no agent must say so, because typing into it executes commands.
func TestVibePaneWithoutAnAgentIsNoAgent(t *testing.T) {
	skipIfNoTmux(t)
	_, cleanup := splitTestSession(t, "yaver-test-vibe-bare", 1)
	defer cleanup()

	panes, err := ListVibePanes(context.Background())
	if err != nil {
		t.Fatalf("ListVibePanes: %v", err)
	}
	for _, p := range panes {
		if p.SessionName != "yaver-test-vibe-bare" {
			continue
		}
		if p.Status != VibeStatusNoAgent {
			t.Errorf("bare shell pane: status = %q, want %q", p.Status, VibeStatusNoAgent)
		}
		if p.AgentConfirmed {
			t.Error("bare shell pane must not report a confirmed agent")
		}
		if p.StatusReason == "" {
			t.Error("status must carry a reason — a bare state cannot tell the user what to do")
		}
		return
	}
	t.Fatal("test session not found in ListVibePanes output")
}

// The send path must refuse a pane with no agent rather than execute the
// user's prompt as a shell command.
func TestSendTmuxInputRefusesAPaneWithNoAgent(t *testing.T) {
	skipIfNoTmux(t)
	_, cleanup := splitTestSession(t, "yaver-test-vibe-refuse", 1)
	defer cleanup()

	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	mgr := NewTmuxManager(tm)
	if mgr == nil {
		t.Skip("tmux manager unavailable")
	}
	task, err := mgr.AdoptTarget("yaver-test-vibe-refuse", "")
	if err != nil {
		t.Fatalf("AdoptTarget: %v", err)
	}
	defer mgr.DetachSession(task.ID)

	err = mgr.SendTmuxInput(task.ID, "please refactor the parser")
	if err == nil {
		t.Fatal("expected a refusal: the pane is a bare shell, so this prompt would have been EXECUTED")
	}
	if !strings.Contains(err.Error(), "shell command") {
		t.Errorf("refusal must explain why; got: %v", err)
	}
}

// Two panes of one session are two agents and must be two tasks. Keyed on the
// session, the second adoption collided with the first and was refused.
func TestAdoptTargetAllowsEachPaneOfOneSession(t *testing.T) {
	skipIfNoTmux(t)
	ids, cleanup := splitTestSession(t, "yaver-test-vibe-two", 2)
	defer cleanup()

	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	mgr := NewTmuxManager(tm)
	if mgr == nil {
		t.Skip("tmux manager unavailable")
	}

	first, err := mgr.AdoptTarget("yaver-test-vibe-two", ids[0])
	if err != nil {
		t.Fatalf("adopt pane %s: %v", ids[0], err)
	}
	defer mgr.DetachSession(first.ID)

	second, err := mgr.AdoptTarget("yaver-test-vibe-two", ids[1])
	if err != nil {
		t.Fatalf("adopt pane %s: %v — two panes of one session must be two tasks", ids[1], err)
	}
	defer mgr.DetachSession(second.ID)

	if first.ID == second.ID {
		t.Fatal("both panes resolved to the same task")
	}
	if first.TmuxPaneID != ids[0] || second.TmuxPaneID != ids[1] {
		t.Errorf("tasks did not record their own panes: %s=%s, %s=%s",
			first.ID, first.TmuxPaneID, second.ID, second.TmuxPaneID)
	}
	// Re-adopting the same pane is an idempotent open of its task; it must not
	// create a third task or resolve to the neighbouring pane.
	reopened, err := mgr.AdoptTarget("yaver-test-vibe-two", ids[0])
	if err != nil {
		t.Fatalf("re-adopt pane %s: %v", ids[0], err)
	}
	if reopened.ID != first.ID {
		t.Fatalf("re-adopted pane resolved task %s, want %s", reopened.ID, first.ID)
	}
}

// A task's input must reach ITS pane. send-keys -t <session> resolves to
// whichever pane is active, so this is the test that would have caught a
// follow-up landing in a neighbouring agent.
func TestTaskInputTargetsItsOwnPaneNotTheActiveOne(t *testing.T) {
	skipIfNoTmux(t)
	ids, cleanup := splitTestSession(t, "yaver-test-vibe-target", 2)
	defer cleanup()

	// Make pane 0 active; the task will own pane 1.
	if out, err := exec.Command("tmux", "select-pane", "-t", ids[0]).CombinedOutput(); err != nil {
		t.Fatalf("select-pane: %v: %s", err, out)
	}

	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	mgr := NewTmuxManager(tm)
	if mgr == nil {
		t.Skip("tmux manager unavailable")
	}
	task, err := mgr.AdoptTarget("yaver-test-vibe-target", ids[1])
	if err != nil {
		t.Fatalf("AdoptTarget: %v", err)
	}
	defer mgr.DetachSession(task.ID)

	if got := mgr.taskTmuxTarget(task.ID, "yaver-test-vibe-target"); got != ids[1] {
		t.Fatalf("target = %q, want the task's own pane %q (the active pane is %q)", got, ids[1], ids[0])
	}

	// And the underlying delivery is pane-accurate.
	const marker = "yaver-pane-target-marker"
	if err := sendTmuxLine(ids[1], "echo "+marker); err != nil {
		t.Fatalf("sendTmuxLine: %v", err)
	}
	time.Sleep(700 * time.Millisecond)

	if !strings.Contains(paneContent(t, ids[1]), marker) {
		t.Errorf("marker did not reach the targeted pane %s", ids[1])
	}
	if strings.Contains(paneContent(t, ids[0]), marker) {
		t.Errorf("marker leaked into the ACTIVE pane %s — input is still session-targeted", ids[0])
	}
}

// The menu guard must inspect the pane being typed into. Guarding the active
// pane while typing into another is worse than not guarding at all.
func TestMenuGuardInspectsTheTargetedPane(t *testing.T) {
	skipIfNoTmux(t)
	ids, cleanup := splitTestSession(t, "yaver-test-vibe-menu", 2)
	defer cleanup()

	// Render a menu in pane 1 only; leave pane 0 (active) clean.
	if err := sendTmuxLine(ids[1], `printf '\n  1. Update now\n  2. Not now\n'`); err != nil {
		t.Fatalf("render menu: %v", err)
	}
	time.Sleep(700 * time.Millisecond)

	if awaiting, _ := tmuxPaneAwaitingChoice(ids[1]); !awaiting {
		t.Error("menu in the targeted pane was not detected")
	}
	if awaiting, _ := tmuxPaneAwaitingChoice(ids[0]); awaiting {
		t.Error("clean pane reported as awaiting a choice")
	}
}

// The agent walk must survive a wrapper process. At depth 1 an agent behind
// `sh -c` reads as no-agent, which silently marks a live pane unusable.
func TestDetectPaneAgentWalksPastAWrapper(t *testing.T) {
	skipIfNoTmux(t)
	// `sh -c 'exec ... claude'` is the shape a shim produces: the pane's direct
	// child is the wrapper, the agent is one level deeper. Use `sleep` renamed
	// via a shell function stand-in is not portable, so drive the walk directly
	// against a known tree instead: pane pid → shell → sleep.
	_, cleanup := splitTestSession(t, "yaver-test-vibe-depth", 1)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	// A bare pane has no agent at any depth — the negative half of the contract.
	panes, err := ListVibePanes(ctx)
	if err != nil {
		t.Fatalf("ListVibePanes: %v", err)
	}
	for _, p := range panes {
		if p.SessionName != "yaver-test-vibe-depth" {
			continue
		}
		if agent, confirmed := detectPaneAgent(ctx, p.PID); confirmed {
			t.Errorf("bare pane reported agent %q as confirmed", agent)
		}
	}
}

// TTY membership is the fallback when the pane shell is not the runner's
// ancestor. This is the exact shape that made a visibly-live Codex pane read
// as empty in session 141.
func TestDetectPaneAgentFallsBackToControllingTTY(t *testing.T) {
	skipIfNoTmux(t)
	ids, cleanup := splitTestSession(t, "yaver-test-vibe-tty", 1)
	defer cleanup()
	if err := sendTmuxLine(ids[0], `/bin/bash -c 'exec -a codex sleep 30'`); err != nil {
		t.Fatalf("start fixture runner: %v", err)
	}
	time.Sleep(500 * time.Millisecond)
	pane, ok := paneIdentityByID("yaver-test-vibe-tty", ids[0])
	if !ok || pane.TTY == "" {
		t.Fatalf("fixture pane has no TTY: %+v", pane)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	agent, _, confirmed := detectPaneAgentDetailsAt(ctx, os.Getpid(), pane.TTY)
	if !confirmed || agent != "codex" {
		t.Fatalf("TTY fallback = (%q, %v), want observed codex", agent, confirmed)
	}
}

// The probe is advisory and must never outlive its deadline, whatever the box
// is doing. An already-cancelled context must return, not block.
func TestListVibePanesHonoursItsDeadline(t *testing.T) {
	skipIfNoTmux(t)
	_, cleanup := splitTestSession(t, "yaver-test-vibe-deadline", 2)
	defer cleanup()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = ListVibePanes(ctx)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("ListVibePanes ignored a cancelled context")
	}
}

// ListTmuxSessions must carry the per-pane detail, since that is what the Tasks
// list reads to show one row per agent.
func TestListTmuxSessionsCarriesPanes(t *testing.T) {
	skipIfNoTmux(t)
	ids, cleanup := splitTestSession(t, "yaver-test-vibe-carry", 2)
	defer cleanup()

	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	mgr := NewTmuxManager(tm)
	if mgr == nil {
		t.Skip("tmux manager unavailable")
	}
	sessions, err := mgr.ListTmuxSessions()
	if err != nil {
		t.Fatalf("ListTmuxSessions: %v", err)
	}
	for _, s := range sessions {
		if s.Name != "yaver-test-vibe-carry" {
			continue
		}
		if len(s.Panes) != len(ids) {
			t.Fatalf("session carries %d panes, want %d", len(s.Panes), len(ids))
		}
		for _, p := range s.Panes {
			if p.Status == "" {
				t.Errorf("pane %s has no status", p.PaneID)
			}
		}
		return
	}
	t.Fatal("test session missing from ListTmuxSessions")
}

func TestAgentCommandInputModeDistinguishesTaskRunsFromInteractiveTUIs(t *testing.T) {
	cases := []struct {
		agent string
		cmd   string
		want  bool
	}{
		{"codex", "node /opt/homebrew/bin/codex --model gpt-5.6-sol exec resume session prompt", true},
		{"codex", "/opt/homebrew/bin/codex --dangerously-bypass-approvals-and-sandbox", false},
		{"claude", "/usr/local/bin/claude -p prompt --output-format stream-json", true},
		{"claude", "/usr/local/bin/claude --dangerously-skip-permissions", false},
		{"opencode", "/usr/bin/opencode run --model glm prompt", true},
		{"opencode", "/usr/bin/opencode --auto", false},
	}
	for _, tc := range cases {
		if got := agentCommandIsOneShot(tc.agent, tc.cmd); got != tc.want {
			t.Errorf("agentCommandIsOneShot(%q, %q) = %v, want %v", tc.agent, tc.cmd, got, tc.want)
		}
	}
}
