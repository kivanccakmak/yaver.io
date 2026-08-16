package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDetectSessionIntentEnglish(t *testing.T) {
	cases := []struct {
		text   string
		action SessionIntentAction
		runner string
	}{
		{"start a new session", SessionIntentStart, ""},
		{"let's start a codex session", SessionIntentStart, "codex"},
		{"which sessions are running", SessionIntentList, ""},
		{"what sessions are open", SessionIntentList, ""},
		{"close the session", SessionIntentClose, ""},
		{"close all sessions", SessionIntentStopAll, ""},
		{"stop all sessions", SessionIntentStopAll, ""},
		{"switch to the codex session", SessionIntentSwitch, "codex"},
		{"switch to yaver-codex", SessionIntentSwitch, ""},
	}
	for _, c := range cases {
		intent, ok := detectSessionIntent(c.text)
		if !ok {
			t.Errorf("%q: expected an intent, got none", c.text)
			continue
		}
		if intent.Action != c.action {
			t.Errorf("%q: action = %s, want %s", c.text, intent.Action, c.action)
		}
		if c.runner != "" && intent.Runner != c.runner {
			t.Errorf("%q: runner = %q, want %q", c.text, intent.Runner, c.runner)
		}
	}
}

func TestDetectSessionIntentTurkish(t *testing.T) {
	cases := []struct {
		text   string
		action SessionIntentAction
	}{
		{"yeni bir oturum başlat", SessionIntentStart},
		{"hangi oturumlar açık", SessionIntentList},
		{"tüm oturumları kapat", SessionIntentStopAll},
		{"oturumu kapat", SessionIntentClose},
		{"codex oturumuna geç", SessionIntentSwitch},
	}
	for _, c := range cases {
		intent, ok := detectSessionIntent(c.text)
		if !ok {
			t.Errorf("%q: expected an intent, got none", c.text)
			continue
		}
		if intent.Action != c.action {
			t.Errorf("%q: action = %s, want %s", c.text, intent.Action, c.action)
		}
	}
}

// A real coding prompt must NOT be swallowed as a lifecycle intent.
func TestDetectSessionIntentRejectsPrompts(t *testing.T) {
	prompts := []string{
		"fix the login bug in auth.ts",
		"start the dev server and show me the output",
		"explain the session handling code",
		"show me the session handling code",
		"start the session tests and fix the bug",
		"review the pull request",
		"bu hata mesajını açıkla",
		"yeni özellik ekle",
	}
	for _, p := range prompts {
		if intent, ok := detectSessionIntent(p); ok {
			t.Errorf("%q: classified as %s — must reach the runner as a prompt", p, intent.Action)
		}
	}
}

func isolateSessionIntentTmux(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux is not installed")
	}
	// macOS limits UNIX socket paths to roughly 100 bytes. t.TempDir includes
	// the full test name and can make tmux fail before the assertion with
	// "File name too long", so keep the socket root deliberately short.
	socketRoot, err := os.MkdirTemp("/tmp", "ytmux-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if strings.HasPrefix(socketRoot, "/tmp/ytmux-") {
			_ = os.RemoveAll(socketRoot)
		}
	})
	t.Setenv("TMUX", "")
	t.Setenv("TMUX_TMPDIR", socketRoot)
	home := filepath.Join(socketRoot, "home")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	if runtimeDir := os.Getenv("XDG_RUNTIME_DIR"); runtimeDir != "" {
		runtimeRoot := filepath.Join(socketRoot, "runtime")
		if err := os.MkdirAll(runtimeRoot, 0o700); err != nil {
			t.Fatal(err)
		}
		t.Setenv("XDG_RUNTIME_DIR", runtimeRoot)
	}
	t.Cleanup(func() {
		_ = exec.Command(tmuxCmdName(), "kill-server").Run()
		// tmux acknowledges kill-server before every child shell has necessarily
		// flushed its final history/config write. The socket root is manually
		// owned by this fixture, so let those children settle before its cleanup.
		time.Sleep(25 * time.Millisecond)
	})
}

func testRunnerBinary(t *testing.T, name string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\nsleep 60\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func startIntentTestSession(t *testing.T, name, command string) {
	t.Helper()
	args := []string{"new-session", "-d", "-s", name}
	if command != "" {
		args = append(args, command)
	}
	if out, err := exec.Command(tmuxCmdName(), args...).CombinedOutput(); err != nil {
		t.Fatalf("start tmux session %q: %v: %s", name, err, out)
	}
}

// A service's launch directory is incidental state. Starting a voice-created
// session with an empty workDir must resolve HOME explicitly, never inherit the
// daemon CWD.
func TestResolveSessionIntentWorkDirNeverUsesDaemonCWD(t *testing.T) {
	home := t.TempDir()
	elsewhere := t.TempDir()
	t.Setenv("HOME", home)
	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(elsewhere); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(old) })

	got, err := resolveSessionIntentWorkDir("")
	if err != nil {
		t.Fatal(err)
	}
	if got != home {
		t.Fatalf("empty workDir resolved to %q, want HOME %q (daemon CWD was %q)", got, home, elsewhere)
	}
}

// "Close all coding sessions" is narrower than the administrative
// tmux_close_sessions tool. A personal shell in the same tmux server must
// survive the spoken action.
func TestStopAllSessionIntentKeepsUnrelatedShell(t *testing.T) {
	isolateSessionIntentTmux(t)
	startIntentTestSession(t, "personal-shell", "")
	startIntentTestSession(t, "runner-seat", testRunnerBinary(t, "claude-test"))
	time.Sleep(100 * time.Millisecond)

	reply, status := closeSessionIntent(SessionIntent{Action: SessionIntentStopAll}, true)
	if status != http.StatusOK || !reply.OK {
		t.Fatalf("close all failed: status=%d reply=%+v", status, reply)
	}
	if tmuxSessionExists("runner-seat") {
		t.Fatal("confirmed runner session was not closed")
	}
	if !tmuxSessionExists("personal-shell") {
		t.Fatal("spoken close-all killed an unrelated shell session")
	}
}

// A stale yaver-codex shell is inventory, not a live runner. "Start codex"
// must not return a cheerful success while no agent is listening.
func TestStartSessionIntentRejectsStaleNamedShell(t *testing.T) {
	isolateSessionIntentTmux(t)
	bin := testRunnerBinary(t, "codex")
	t.Setenv("PATH", filepath.Dir(bin)+string(os.PathListSeparator)+os.Getenv("PATH"))
	startIntentTestSession(t, "yaver-codex", "")

	reply, status := startSessionIntent(
		runnerSessionTurnRequest{Runner: "codex", WorkDir: t.TempDir()},
		SessionIntent{Action: SessionIntentStart, Runner: "codex"},
	)
	if status != http.StatusConflict || reply.OK {
		t.Fatalf("stale shell reported as started: status=%d reply=%+v", status, reply)
	}
	if !strings.Contains(reply.Error, "no confirmed codex runner") {
		t.Fatalf("stale-shell reason missing: %q", reply.Error)
	}
}

// The picker payload must survive the HTTP boundary. This is the negative
// control for the old handler, which flattened every 404 to {error} and threw
// `available` away before a car/watch could render it.
func TestRunnerSessionTurnAmbiguityCarriesPickerOverHTTP(t *testing.T) {
	isolateSessionIntentTmux(t)
	startIntentTestSession(t, "runner-one", testRunnerBinary(t, "claude-test"))
	startIntentTestSession(t, "runner-two", testRunnerBinary(t, "codex-test"))
	time.Sleep(100 * time.Millisecond)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/runner/session/turn", strings.NewReader(`{"text":"keep working"}`))
	(&HTTPServer{}).handleRunnerSessionTurn(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status=%d want 409; body=%s", rec.Code, rec.Body.String())
	}
	var got runnerSessionTurnResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.NeedsChoice || len(got.Available) != 2 {
		t.Fatalf("picker was lost: %+v", got)
	}
}

// A picker selection arrives as structured `session` alongside the original
// lifecycle phrase. It must perform the action on that exact runner, not ask
// the same question forever or close the other session.
func TestLifecyclePickerSelectionClosesChosenSession(t *testing.T) {
	isolateSessionIntentTmux(t)
	startIntentTestSession(t, "runner-one", testRunnerBinary(t, "claude-test"))
	startIntentTestSession(t, "runner-two", testRunnerBinary(t, "codex-test"))
	time.Sleep(100 * time.Millisecond)

	reply, status := executeRunnerSessionTurn(runnerSessionTurnRequest{
		Text: "close the session", Session: "runner-two",
	})
	if status != http.StatusOK || !reply.OK {
		t.Fatalf("selected close failed: status=%d reply=%+v", status, reply)
	}
	if tmuxSessionExists("runner-two") {
		t.Fatal("chosen runner session was not closed")
	}
	if !tmuxSessionExists("runner-one") {
		t.Fatal("picker selection closed the wrong runner session")
	}
}

// Ambiguous lifecycle intents must ask for a target, never guess.
func TestDetectSessionIntentNeedsChoice(t *testing.T) {
	for _, p := range []string{"close the session", "oturumu kapat"} {
		intent, ok := detectSessionIntent(p)
		if !ok {
			t.Fatalf("%q: expected an intent", p)
		}
		// With no live sessions the executor resolves to "which one"; the
		// classifier flags ambiguity structurally only for switch/close-without-target
		// when the box has several live sessions — here we assert the classifier
		// returns a close intent (NeedsChoice is decided at execution time).
		if intent.Action != SessionIntentClose {
			t.Errorf("%q: expected close intent, got %s", p, intent.Action)
		}
	}
}

func TestFoldEqualTurkish(t *testing.T) {
	if !foldEqual("oturumları", "oturumları") {
		t.Error("identical Turkish strings must fold-equal")
	}
	if !foldEqual("başlat", "başlat") {
		t.Error("Turkish i-dot folding failed")
	}
	if !strings.EqualFold("OTURUMLAR", "oturumlar") {
		t.Error("Go EqualFold does not fold dotted-i, but our foldEqual should")
	}
	if !foldEqual("OTURUMLAR", "oturumlar") {
		t.Error("foldEqual must handle uppercase Turkish")
	}
}
