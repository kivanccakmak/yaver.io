package main

// Tmux-backed runner spawn.
//
// Why: when the yaver daemon is started outside the user's GUI login session
// (launchd, ssh, headless), Claude Code can't read the user's macOS Keychain
// item "Claude Code-credentials" — even when running as the same UNIX user
// — because Keychain unlocking is per login session. Result: every task
// fails with "Not logged in · Please run /login". The user's own interactive
// `claude` running in a tmux pane *is* authenticated. Routing tasks into
// that tmux server's environment lets them inherit that auth.
//
// Ordinary Claude, Codex and OpenCode tasks get an isolated session by
// default. YAVER_TASK_TMUX=0 is the explicit escape hatch, while
// YAVER_TMUX_RUNNER=<session> preserves the legacy operator-owned shared
// session override. startProcess and startResume both wrap eligible spawns in
// a shell orchestration that:
//
//   1. creates or reuses the task's exact window in its tmux session,
//   2. runs the runner inside that window,
//   3. mirrors the pane via `pipe-pane` to a logfile,
//   4. tails the logfile to our own stdout so the existing readStreamJSON
//      / readRawOutput pipeline keeps working unchanged,
//   5. blocks via `tmux wait-for` until the inner runner exits,
//   6. recovers the inner exit code from a marker line and propagates it.
//
// A task-owned session remains addressable after completion, failure, or stop;
// DELETE /tasks/{id} is its sole teardown boundary. Operator-owned shared
// overrides retain their historical per-turn window cleanup.
//
// Limitation: stdout and stderr merge inside the pane. For claude
// stream-json output mode this means JSON lines and human stderr text
// interleave; readStreamJSON tolerates non-JSON lines, so it's livable for
// a first cut.

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const tmuxRunnerEnvVar = "YAVER_TMUX_RUNNER"
const taskTmuxEnvVar = "YAVER_TASK_TMUX"

type tmuxRunnerTarget struct {
	Session       string
	CreateSession bool
}

// tmuxRunnerSession returns the opt-in session name from the daemon's env
// (empty string = feature off).
func tmuxRunnerSession() string {
	return strings.TrimSpace(os.Getenv(tmuxRunnerEnvVar))
}

// tmuxRunnerEligible: which runners benefit from tmux dispatch. Claude
// needs the user's interactive login session for macOS Keychain access.
// OpenCode also benefits because its interactive UI otherwise redraws in
// ways that are hard to inspect after the fact; the wrapper disables the
// tmux alternate screen so normal copy-mode scrollback keeps the transcript.
func tmuxRunnerEligible(runnerID string) bool {
	switch strings.ToLower(strings.TrimSpace(runnerID)) {
	case "claude", "claude-code", "opencode":
		return true
	case "codex":
		// Codex doesn't need the login-session Keychain, but tmux dispatch
		// gives its `exec` runs the same pane-mirrored live view + post-hoc
		// scrollback the other runners get — and the pane is adoptable from
		// the phone (tmux_adopt_session). Opt-in via YAVER_TMUX_RUNNER as
		// with every runner.
		return true
	}
	return false
}

// tmuxRunnerReady checks that tmux is available and the configured session
// exists. Returns the session name on success, "" on any failure (so the
// caller can fall through to the direct exec path without surfacing an
// error to the user). Cheap enough to call on every task start.
func tmuxRunnerReady() string {
	session := tmuxRunnerSession()
	if session == "" {
		return ""
	}
	if !tmuxAvailable() {
		return ""
	}
	if exec.Command(tmuxCmdName(), "has-session", "-t", session).Run() != nil {
		return ""
	}
	return session
}

// taskTmuxEnabled is the product default for first-class coding runners.
//
// Before 2026-08-23, ordinary phone/web tasks bypassed tmux unless the daemon
// happened to be started with YAVER_TMUX_RUNNER. The interactive `yaver codex`
// lane was attachable, while the much more common Tasks lane was not. That was
// an inventory/operation split: the clients advertised tmux attach, but the
// runner the user was watching did not live in any session.
//
// Keep an explicit escape hatch for constrained embeddings and tests. Missing
// tmux is handled by the existing startup installer and then degrades to the
// direct CLI lane; it must never make coding itself unavailable.
func taskTmuxEnabled(runnerID string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(taskTmuxEnvVar))) {
	case "0", "false", "off", "no":
		return false
	}
	return tmuxRunnerEligible(runnerID) && tmuxAvailable()
}

// automaticTaskTmuxSessionName gives every task one exact attach target. A
// shared yaver-codex session with one window per task made an attach land on
// whichever window happened to be active; a per-task session makes the task,
// the pane and the mobile terminal refer to the same operation by construction.
func automaticTaskTmuxSessionName(taskID, runnerID string) string {
	runner := normalizeRunnerID(runnerID)
	if runner == "" {
		runner = "runner"
	}
	return "yaver-task-" + shortTaskKey(taskID) + "-" + runner
}

func tmuxRunnerTargetForTask(taskID, runnerID string) tmuxRunnerTarget {
	if !tmuxRunnerEligible(runnerID) {
		return tmuxRunnerTarget{}
	}
	// Preserve the legacy operator override: an explicitly configured session
	// keeps the old shared-session/window behaviour.
	if session := tmuxRunnerReady(); session != "" {
		return tmuxRunnerTarget{Session: session}
	}
	if !taskTmuxEnabled(runnerID) {
		return tmuxRunnerTarget{}
	}
	return tmuxRunnerTarget{
		Session:       automaticTaskTmuxSessionName(taskID, runnerID),
		CreateSession: true,
	}
}

// shellQuoteStrict single-quotes a value safely for sh, escaping any embedded
// single quotes with the standard POSIX shell sequence.
func shellQuoteStrict(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func shellJoin(args []string) string {
	parts := make([]string, len(args))
	for i, a := range args {
		parts[i] = shellQuoteStrict(a)
	}
	return strings.Join(parts, " ")
}

// shortTaskKey derives a filesystem- and tmux-safe short id from a task
// id (12 chars, [A-Za-z0-9_-] only). The full task id can contain hyphens
// already; we keep them, swap anything else to '-'.
func shortTaskKey(taskID string) string {
	short := taskID
	if len(short) > 12 {
		short = short[:12]
	}
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z':
			return r
		case r >= 'A' && r <= 'Z':
			return r
		case r >= '0' && r <= '9':
			return r
		case r == '-' || r == '_':
			return r
		default:
			return '-'
		}
	}, short)
}

// tmuxRunnerScript is the orchestration program. Reads parameters from
// env vars (set by buildTmuxRunnerCommand) so we don't have to deal with
// quoting them through `sh -c`.
//
// One quirk worth highlighting: the inner command (runner + args) is
// passed pre-shell-quoted in $YAVER_TMUX_INNER and we let tmux's own
// `sh -c` evaluate it. Anything dangerous is single-quoted by shellJoin
// at the Go layer, so $HOME and friends won't be expanded.
const tmuxRunnerScript = `set -eu
SESSION=$YAVER_TMUX_SESSION
WIN=$YAVER_TMUX_WIN
SIG=$YAVER_TMUX_SIG
LOG=$YAVER_TMUX_LOG
CREATE_SESSION=$YAVER_TMUX_CREATE_SESSION
RUNNER=$YAVER_TMUX_RUNNER_ID
CWD=$YAVER_TMUX_CWD
TARGET=
cleanup() {
  if [ -n "${TAIL_PID:-}" ]; then kill "$TAIL_PID" 2>/dev/null || true; fi
  if [ "$CREATE_SESSION" = "1" ]; then
    # A runner turn ending does not end the user's task. Keep the exact
    # session/window/pane and its scrollback until an explicit Complete, Stop,
    # or Delete lifecycle action tears the task-owned seat down.
    tmux pipe-pane -t "$TARGET" 2>/dev/null || true
  else
    tmux kill-window -t "$SESSION:$WIN" 2>/dev/null || true
  fi
  rm -f -- "$LOG"
}
trap cleanup TERM INT HUP EXIT

: > "$LOG"
if [ "$CREATE_SESSION" = "1" ]; then
  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux new-session -d -s "$SESSION" -n "$WIN" -c "$CWD"
  fi
  TARGET="$SESSION:$WIN.0"
else
  tmux kill-window -t "$SESSION:$WIN" 2>/dev/null || true
  tmux new-window -d -t "$SESSION" -n "$WIN" -c "$CWD"
  TARGET="$SESSION:$WIN"
fi

# These are hints for inventory/display only. Prompt delivery still requires
# process observation (agentConfirmed); a stale option can never authorize
# typing into a shell.
tmux set-option -q -t "$SESSION" @yaver-runner "$RUNNER" 2>/dev/null || true
tmux set-option -q -t "$SESSION" @yaver-task-id "$YAVER_TMUX_TASK_ID" 2>/dev/null || true
tmux set-window-option -q -t "$TARGET" automatic-rename off 2>/dev/null || true
tmux set-window-option -q -t "$TARGET" remain-on-exit on 2>/dev/null || true
tmux set-window-option -q -t "$TARGET" alternate-screen off 2>/dev/null || true

# Install capture BEFORE launching the runner. The previous order sent the
# command first and could lose a fast runner's entire answer before pipe-pane
# attached — especially the exact hello-world probe used to verify OAuth.
tmux pipe-pane -o -t "$TARGET" "cat >> '$LOG'"
tmux send-keys -t "$TARGET" \
  "$YAVER_TMUX_INNER; rc=\$?; printf '\n__YAVER_EXIT__:%d\n' \"\$rc\"; tmux wait-for -S \"$SIG\"" Enter

tail -n +1 -F "$LOG" 2>/dev/null &
TAIL_PID=$!

tmux wait-for "$SIG"

sleep 0.2
kill "$TAIL_PID" 2>/dev/null || true
TAIL_PID=

EXIT=$(grep -E '^__YAVER_EXIT__:[0-9]+$' "$LOG" 2>/dev/null | tail -1 | sed -e 's/.*://')
exit "${EXIT:-1}"
`

// buildTmuxRunnerCommand returns an *exec.Cmd that, when run, dispatches
// the runner into a fresh window of the named tmux session and streams
// its merged output back via the wrapper sh's stdout. The returned cmd
// behaves like a normal subprocess for the rest of tasks.go: Wait blocks
// until the inner runner exits, the inner exit code surfaces as the
// wrapper's exit code, and Process.Kill / ctx-cancel tears down the
// pane via the trap in tmuxRunnerScript.
//
// Caller is expected to set cmd.Dir / cmd.Env (taskEnv) and to
// supplement cmd.Env with the YAVER_TMUX_* values returned here. We
// hand back the env additions rather than baking them in so the
// existing taskEnv() call site stays the source of truth for everything
// else.
func buildTmuxRunnerCommand(
	ctx context.Context,
	target tmuxRunnerTarget,
	taskID string,
	runnerID string,
	workDir string,
	runnerCmd string,
	runnerArgs []string,
	runnerEnv []string,
) (*exec.Cmd, []string) {
	short := shortTaskKey(taskID)
	win := "yaver-task-" + short
	sig := "yaver-done-" + short
	logPath := fmt.Sprintf("/tmp/yaver-tmux-%s.log", short)
	innerCmd := append([]string{}, runnerEnv...)
	innerCmd = append(innerCmd, runnerCmd)
	innerCmd = append(innerCmd, runnerArgs...)
	if len(runnerEnv) > 0 {
		innerCmd = append([]string{"env"}, innerCmd...)
	}
	inner := shellJoin(innerCmd)

	cmd := exec.CommandContext(ctx, "sh", "-c", tmuxRunnerScript)
	createSession := "0"
	if target.CreateSession {
		createSession = "1"
	}
	envAdditions := []string{
		"YAVER_TMUX_SESSION=" + target.Session,
		"YAVER_TMUX_WIN=" + win,
		"YAVER_TMUX_SIG=" + sig,
		"YAVER_TMUX_LOG=" + logPath,
		"YAVER_TMUX_INNER=" + inner,
		"YAVER_TMUX_CREATE_SESSION=" + createSession,
		"YAVER_TMUX_RUNNER_ID=" + normalizeRunnerID(runnerID),
		"YAVER_TMUX_TASK_ID=" + taskID,
		"YAVER_TMUX_CWD=" + workDir,
	}
	return cmd, envAdditions
}

// waitForTmuxTaskPane resolves the exact session/window/pane created by the
// wrapper. It is deliberately bounded: tmux identity is useful attachment
// metadata, never permission to block POST /tasks.
func waitForTmuxTaskPane(session, taskID string, timeout time.Duration) tmuxPaneIdentity {
	deadline := time.Now().Add(timeout)
	wantWindow := "yaver-task-" + shortTaskKey(taskID)
	for time.Now().Before(deadline) {
		remaining := time.Until(deadline)
		if remaining > 100*time.Millisecond {
			remaining = 100 * time.Millisecond
		}
		ctx, cancel := context.WithTimeout(context.Background(), remaining)
		out, err := exec.CommandContext(ctx, tmuxCmdName(), "list-panes", "-t", session+":"+wantWindow, "-F",
			"#{session_id}|#{window_index}|#{window_name}|#{pane_index}|#{pane_id}|#{pane_pid}").CombinedOutput()
		cancel()
		if err == nil {
			for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
				parts := strings.SplitN(line, "|", 6)
				if len(parts) != 6 {
					continue
				}
				pid, _ := strconv.Atoi(parts[5])
				return tmuxPaneIdentity{
					SessionID: parts[0], WindowIndex: parts[1], WindowName: parts[2],
					PaneIndex: parts[3], PaneID: parts[4], PanePID: pid,
				}
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	return tmuxPaneIdentity{}
}
