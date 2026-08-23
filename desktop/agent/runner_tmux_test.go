package main

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
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
	if !strings.Contains(cmd.Args[2], "tmux new-session") || !strings.Contains(cmd.Args[2], "tmux kill-session") {
		t.Fatalf("automatic wrapper must own an exact session: %s", cmd.Args[2])
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
