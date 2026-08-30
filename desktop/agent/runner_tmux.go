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
	"path/filepath"
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

// tmuxSessionNameMetadata is the canonical interpretation of Yaver-owned tmux
// names. Every producer/consumer uses this parser; mobile, web, and Convex get
// structured fields and never maintain their own split-on-dash copies.
type tmuxSessionNameMetadata struct {
	Kind        string
	Origin      string
	Runner      string
	ProjectHint string
	TaskIDHint  string
	InputMode   string
	StartedAt   time.Time
}

func parseYaverTmuxSessionName(name string) tmuxSessionNameMetadata {
	name = strings.TrimSpace(name)
	const taskPrefix = "yaver-task-"
	if strings.HasPrefix(name, taskPrefix) {
		rest := strings.TrimPrefix(name, taskPrefix)
		// Current descriptive shape: YYMMDD-HHMM-runner-project-taskid.
		if len(rest) > 12 && rest[6] == '-' && rest[11] == '-' {
			stamp := rest[:11]
			tail := rest[12:]
			first, last := strings.IndexByte(tail, '-'), strings.LastIndexByte(tail, '-')
			if first > 0 && last > first+1 && last < len(tail)-1 {
				runner := normalizeRunnerID(tail[:first])
				project := strings.Trim(tail[first+1:last], "-")
				taskID := strings.Trim(tail[last+1:], "-")
				started, err := time.ParseInLocation("060102-1504", stamp, time.Local)
				if tmuxRunnerEligible(runner) && project != "" && taskID != "" && err == nil {
					return tmuxSessionNameMetadata{
						Kind: "task", Origin: "yaver-task", Runner: runner, ProjectHint: project,
						TaskIDHint: taskID, InputMode: VibeInputTaskFollowUp, StartedAt: started,
					}
				}
			}
		}

		// Legacy shape: yaver-task-<short-task-id>-<runner>. Task ids can
		// contain dashes, so split from the runner suffix, not from the left.
		if last := strings.LastIndexByte(rest, '-'); last > 0 && last < len(rest)-1 {
			if runner := normalizeRunnerID(rest[last+1:]); tmuxRunnerEligible(runner) {
				return tmuxSessionNameMetadata{
					Kind: "task", Origin: "yaver-task", Runner: runner, TaskIDHint: rest[:last],
					InputMode: VibeInputTaskFollowUp,
				}
			}
		}
		return tmuxSessionNameMetadata{Kind: "task", Origin: "yaver-task", InputMode: VibeInputTaskFollowUp}
	}

	const autorunPrefix = "yaver-autorun-"
	if strings.HasPrefix(name, autorunPrefix) {
		rest := strings.TrimPrefix(name, autorunPrefix)
		if last := strings.LastIndexByte(rest, '-'); last > 0 && last < len(rest)-1 {
			if runner := normalizeRunnerID(rest[last+1:]); tmuxRunnerEligible(runner) {
				return tmuxSessionNameMetadata{
					Kind: "autorun", Origin: "yaver-autorun", Runner: runner, TaskIDHint: rest[:last],
					InputMode: VibeInputInteractive,
				}
			}
		}
		return tmuxSessionNameMetadata{Kind: "autorun", Origin: "yaver-autorun", InputMode: VibeInputInteractive}
	}

	if strings.HasPrefix(name, "yaver-") {
		if runner := normalizeRunnerID(strings.TrimPrefix(name, "yaver-")); tmuxRunnerEligible(runner) {
			return tmuxSessionNameMetadata{Kind: "runner", Origin: "yaver-runner", Runner: runner, InputMode: VibeInputInteractive}
		}
	}
	return tmuxSessionNameMetadata{Kind: "other", Origin: "manual"}
}

func normalizeTmuxOrigin(origin string) string {
	switch strings.TrimSpace(origin) {
	case "yaver-task", "yaver-autorun", "yaver-runner", "manual":
		return strings.TrimSpace(origin)
	default:
		return ""
	}
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

// automaticTaskTmuxSessionName is the pre-2026-08-30 task-seat name. Keep it
// for restart/readoption compatibility: deployed agents may have persisted a
// live seat under this name, and changing the ownership test would turn that
// recoverable process into an interrupted task after an agent upgrade.
func automaticTaskTmuxSessionName(taskID, runnerID string) string {
	runner := normalizeRunnerID(runnerID)
	if runner == "" {
		runner = "runner"
	}
	return "yaver-task-" + shortTaskKey(taskID) + "-" + runner
}

// taskTmuxNameHint makes a short, safe human hint. Task.ProjectName is the
// portable identity selected by the surface; the work-dir basename is the
// operation-level fallback when an older caller did not send it. Never put the
// absolute work dir in a tmux name: the session ledger syncs names to Convex.
func taskTmuxNameHint(projectName, workDir string) string {
	raw := strings.TrimSpace(projectName)
	if raw == "" {
		raw = filepath.Base(strings.TrimSpace(workDir))
	}
	if raw == "" || raw == "." || raw == string(filepath.Separator) {
		raw = "project"
	}

	var b strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(raw) {
		valid := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
		if valid {
			b.WriteRune(r)
			lastDash = false
		} else if b.Len() > 0 && !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
		if b.Len() >= 9 {
			break
		}
	}
	return strings.Trim(strings.TrimSpace(b.String()), "-")
}

// descriptiveTaskTmuxSessionName gives every new task one exact attach target
// that is also useful in `tmux ls`:
//
//	yaver-task-260830-1902-codex-yaver-io-f85f4b
//
// The timestamp is the task's creation/start time in its recorded timezone;
// runner and project identify the operation, while the task suffix prevents
// two starts in the same minute from colliding. The 48-character ceiling is
// deliberate: /ws/runner's strict tmux target validator has the same bound.
func descriptiveTaskTmuxSessionName(task *Task, runnerID string) string {
	runner := normalizeRunnerID(runnerID)
	if runner == "" {
		runner = "runner"
	}
	started := "000000-0000"
	project, taskID := "project", "task"
	if task != nil {
		if !task.CreatedAt.IsZero() {
			started = task.CreatedAt.Format("060102-1504")
		}
		if hint := taskTmuxNameHint(task.ProjectName, task.WorkDir); hint != "" {
			project = hint
		}
		if key := shortTaskKey(task.ID); key != "" {
			taskID = key
		}
	}
	if len(taskID) > 6 {
		taskID = taskID[:6]
	}
	name := fmt.Sprintf("yaver-task-%s-%s-%s-%s", started, runner, project, taskID)
	if len(name) > 48 {
		name = name[:48]
	}
	return strings.TrimRight(name, "-")
}

// taskOwnsNamedTmuxSeat accepts both the descriptive current name and the
// legacy short name. It is the single ownership predicate used by lifecycle,
// restart recovery, and deletion; a name that merely starts with yaver-task is
// never enough to claim a user's session.
func taskOwnsNamedTmuxSeat(task *Task) bool {
	if task == nil || task.IsAdopted {
		return false
	}
	session := strings.TrimSpace(task.TmuxSession)
	return session != "" && (session == descriptiveTaskTmuxSessionName(task, task.RunnerID) ||
		session == automaticTaskTmuxSessionName(task.ID, task.RunnerID))
}

func tmuxRunnerTargetForTask(task *Task, runnerID string) tmuxRunnerTarget {
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
		Session:       descriptiveTaskTmuxSessionName(task, runnerID),
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
tmux set-option -q -t "$SESSION" @yaver-input-mode "task-followup" 2>/dev/null || true
if [ "$CREATE_SESSION" = "1" ]; then
  tmux set-option -q -t "$SESSION" @yaver-origin "yaver-task" 2>/dev/null || true
fi
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

# tmux panes commonly write CRLF on macOS even when the runner command itself
# is a Unix process. Normalize CR before matching: otherwise a visible
# __YAVER_EXIT__:0 becomes an empty EXIT and the wrapper falsely returns 1.
EXIT=$(tr -d '\r' < "$LOG" 2>/dev/null | grep -E '^__YAVER_EXIT__:[0-9]+$' | tail -1 | sed -e 's/.*://')
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
