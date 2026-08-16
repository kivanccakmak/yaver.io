package main

// session_intent_exec.go — executing a parsed SessionIntent inside the turn
// path. The turn endpoint is transport-agnostic (HTTP + MCP share it), so the
// lifecycle actions here must be safe to run from a watch, a car, or an LLM:
//
//   - list    → read-only, returns the live runner sessions + a spoken line
//   - start   → launch a runner seat in tmux (detached, persisted) so the
//     caller can then drive it with /runner/session/turn. Mirrors what
//     `yaver wrap <runner>` does interactively, minus the foreground TUI —
//     a seat in tmux is the durable form a watch/car can actually use.
//   - close   → close the named/only session; stop_all closes every runner seat
//   - switch  → resolves to a target so the caller's next turn drives it
//
// Safety: the same rules as prompts. We never start/close without a clear
// target (NeedsChoice surfaces the picker). We never close a session whose
// pane holds a bare shell that might be the user's own work — close only
// targets sessions classified as runner seats by listRunnerPTYSessions.

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// executeSessionIntent handles a natural-language session command. It returns
// the same runnerSessionTurnResponse shape the turn endpoint uses so a caller
// already looping on /runner/session/turn handles intents with zero changes.
func executeSessionIntent(req runnerSessionTurnRequest, intent SessionIntent) (runnerSessionTurnResponse, int) {
	// A constrained surface resolves an ambiguous lifecycle phrase by replaying
	// the SAME phrase with the chosen session in the structured request field.
	// The classifier only sees the phrase, so merge the transport-level target
	// before dispatch. Without this, "close the session" kept asking forever
	// even after the driver picked a session by number.
	if intent.SessionName == "" {
		intent.SessionName = sanitizeTmuxSessionName(req.Session)
	}
	if intent.Runner == "" {
		intent.Runner = normalizeRunnerID(req.Runner)
	}
	switch intent.Action {
	case SessionIntentList:
		return listSessionsIntent(intent)
	case SessionIntentStart:
		return startSessionIntent(req, intent)
	case SessionIntentClose:
		return closeSessionIntent(intent, false)
	case SessionIntentStopAll:
		return closeSessionIntent(intent, true)
	case SessionIntentSwitch:
		return switchSessionIntent(intent)
	}
	return runnerSessionTurnResponse{Error: "unsupported session intent"}, http.StatusBadRequest
}

// listSessionsIntent reports the live runner sessions and a spoken summary.
func listSessionsIntent(intent SessionIntent) (runnerSessionTurnResponse, int) {
	sessions := confirmedRunnerSessions()
	if len(sessions) == 0 {
		return runnerSessionTurnResponse{
			OK:      true,
			Sent:    "list",
			Pane:    "",
			Session: "",
		}, http.StatusOK
	}
	names := make([]string, 0, len(sessions))
	for _, s := range sessions {
		names = append(names, s.Name)
	}
	return runnerSessionTurnResponse{
		OK:        true,
		Sent:      "list",
		Session:   strings.Join(names, ", "),
		Pane:      strings.Join(names, "\n"),
		Error:     "",
		Available: sessionChoices(sessions),
	}, http.StatusOK
}

// startSessionIntent launches a detached runner seat in tmux. The runner
// comes from the intent when named ("start a codex session"), else the box's
// default. Returns the session name so the caller can drive it next turn.
func startSessionIntent(req runnerSessionTurnRequest, intent SessionIntent) (runnerSessionTurnResponse, int) {
	workDir, err := resolveSessionIntentWorkDir(req.WorkDir)
	if err != nil {
		return runnerSessionTurnResponse{Error: err.Error()}, http.StatusBadRequest
	}
	runnerID := strings.TrimSpace(intent.Runner)
	if runnerID == "" {
		runnerID = normalizeRunnerID(req.Runner)
	}
	if runnerID == "" {
		// Pick from what this machine can ACTUALLY launch. Hard-coding claude
		// reported a missing-tool error on boxes whose configured/installed
		// runner was codex or opencode.
		runnerID = ProbeLocalInventory(ProbeContext{WorkDir: workDir}).PreferredRunner
	}
	if runnerID == "" {
		return runnerSessionTurnResponse{
			Error: "no supported coding runner is installed on this machine — install claude, codex, or opencode first",
		}, http.StatusNotFound
	}
	if !IsSupportedRunner(runnerID) {
		return runnerSessionTurnResponse{
			OK:    false,
			Error: fmt.Sprintf("unsupported runner %q — expected claude, codex, or opencode", runnerID),
		}, http.StatusBadRequest
	}
	rc := builtinRunners[runnerID]

	// The seat must be genuinely launchable — same check the WS path uses.
	if _, err := exec.LookPath(rc.Command); err != nil {
		return runnerSessionTurnResponse{
			OK:    false,
			Error: fmt.Sprintf("%s is not installed on this machine — install it first", rc.Command),
		}, http.StatusNotFound
	}

	// A runner seat in tmux is a PERSISTED session: the turn endpoint and the
	// watch/car surfaces can drive it after this call returns, even if the
	// original client drops. Name it the canonical yaver-<runner>.
	sessionName := "yaver-" + runnerID

	// If it already exists (and is confirmed live), just point at it — this is
	// the "start a session" → "it's already running" case.
	if tmuxSessionExists(sessionName) {
		if existing, ok := confirmedRunnerSessionNamed(sessionName); ok && existing.Runner == runnerID {
			return runnerSessionTurnResponse{
				OK:      true,
				Sent:    "start",
				Session: sessionName,
				Runner:  runnerID,
			}, http.StatusOK
		}
		return runnerSessionTurnResponse{
			Session: sessionName,
			Runner:  runnerID,
			Error:   fmt.Sprintf("session %q exists but no confirmed %s runner is listening there — open or close that stale session before starting a new one", sessionName, runnerID),
		}, http.StatusConflict
	}

	if err := launchRunnerSeat(sessionName, runnerID, rc, workDir); err != nil {
		return runnerSessionTurnResponse{
			OK:    false,
			Error: "could not start the session: " + err.Error(),
		}, http.StatusInternalServerError
	}
	return runnerSessionTurnResponse{
		OK:      true,
		Sent:    "start",
		Session: sessionName,
		Runner:  runnerID,
		Error:   "",
	}, http.StatusOK
}

// launchRunnerSeat starts a coding runner in a detached tmux session so the
// runner survives the caller and can be driven by /runner/session/turn.
func launchRunnerSeat(sessionName, runnerID string, rc RunnerConfig, workDir string) error {
	if runnerID == "claude" {
		_ = ensureClaudeFolderTrustedForLocalHome(workDir)
	}
	prepareCodexForHeadlessRun(workDir)
	parts := append([]string{resolveRunnerBinary(rc.Command)}, interactiveRunnerArgs(runnerID)...)
	quoted := make([]string, 0, len(parts))
	for _, p := range parts {
		quoted = append(quoted, shellQuoteSingle(p))
	}
	cmd := exec.Command(tmuxCmdName(), "new-session", "-d", "-s", sessionName, "-c", workDir, strings.Join(quoted, " "))
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("start %s TUI in tmux: %w: %s", runnerID, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// closeSessionIntent closes the named runner seat, or all of them.
func closeSessionIntent(intent SessionIntent, all bool) (runnerSessionTurnResponse, int) {
	if all {
		results := closeConfirmedRunnerSessions()
		return runnerSessionTurnResponse{
			OK:      true,
			Sent:    "stop_all",
			Session: fmt.Sprintf("%d session(s) closed", len(results)),
		}, http.StatusOK
	}
	name := strings.TrimSpace(intent.SessionName)
	if name == "" {
		// The phrase named a runner ("close the codex session").
		sessions := confirmedRunnerSessions()
		if intent.Runner != "" {
			for _, s := range sessions {
				if s.Runner == intent.Runner {
					name = s.Name
					break
				}
			}
		}
		if name == "" {
			if len(sessions) == 1 {
				name = sessions[0].Name
			} else {
				return runnerSessionTurnResponse{
					OK:          true,
					Sent:        "close",
					NeedsChoice: true,
					Available:   sessionChoices(sessions),
					Error:       "Which session should I close? Say the name.",
				}, http.StatusOK
			}
		}
	}
	existing, ok := confirmedRunnerSessionNamed(name)
	if !ok {
		return runnerSessionTurnResponse{
			OK:      false,
			Sent:    "close",
			Session: name,
			Error:   "no confirmed coding session named " + name + " is running; refusing to close a shell or unrelated tmux session",
		}, http.StatusNotFound
	}
	if intent.Runner != "" && existing.Runner != intent.Runner {
		return runnerSessionTurnResponse{
			OK: false, Sent: "close", Session: name,
			Error: fmt.Sprintf("session %q is %s, not %s; refusing to close the wrong runner", name, existing.Runner, intent.Runner),
		}, http.StatusConflict
	}
	if out, err := exec.Command(tmuxCmdName(), "kill-session", "-t", name).CombinedOutput(); err != nil {
		return runnerSessionTurnResponse{
			OK:    false,
			Error: "could not close " + name + ": " + strings.TrimSpace(string(out)),
		}, http.StatusInternalServerError
	}
	return runnerSessionTurnResponse{
		OK:      true,
		Sent:    "close",
		Session: name,
		Error:   "",
	}, http.StatusOK
}

// switchSessionIntent resolves a named/typed target so the caller's next turn
// drives that session. It never types anything.
func switchSessionIntent(intent SessionIntent) (runnerSessionTurnResponse, int) {
	name := strings.TrimSpace(intent.SessionName)
	if name == "" && intent.Runner != "" {
		for _, s := range confirmedRunnerSessions() {
			if s.Runner == intent.Runner {
				name = s.Name
				break
			}
		}
	}
	if name == "" {
		sessions := confirmedRunnerSessions()
		return runnerSessionTurnResponse{
			OK:          true,
			Sent:        "switch",
			NeedsChoice: true,
			Available:   sessionChoices(sessions),
			Error:       "Which session should I switch to? Say the name.",
		}, http.StatusOK
	}
	if _, ok := confirmedRunnerSessionNamed(name); !ok {
		return runnerSessionTurnResponse{
			OK:      false,
			Sent:    "switch",
			Session: name,
			Error:   "no confirmed live coding session named " + name + ".",
		}, http.StatusNotFound
	}
	return runnerSessionTurnResponse{
		OK:      true,
		Sent:    "switch",
		Session: name,
		Runner:  intent.Runner,
		Error:   "",
	}, http.StatusOK
}

// resolveSessionIntentWorkDir deliberately never uses the daemon's CWD. A
// remote service can be launched from HOME, /, or a package directory; treating
// that incidental location as the user's project is the exact class of bug
// that once made task placement scan an entire home tree.
func resolveSessionIntentWorkDir(requested string) (string, error) {
	dir := strings.TrimSpace(requested)
	if dir == "" {
		var err error
		dir, err = os.UserHomeDir()
		if err != nil || strings.TrimSpace(dir) == "" {
			return "", fmt.Errorf("start a session needs a project directory; the current user's home directory could not be resolved")
		}
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", fmt.Errorf("resolve session work directory: %w", err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("session work directory %q is unavailable: %w", abs, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("session work directory %q is not a directory", abs)
	}
	return abs, nil
}

func confirmedRunnerSessions() []RunnerPTYSession {
	all := listRunnerPTYSessions()
	out := make([]RunnerPTYSession, 0, len(all))
	for _, s := range all {
		if s.Confirmed {
			out = append(out, s)
		}
	}
	return out
}

func confirmedRunnerSessionNamed(name string) (RunnerPTYSession, bool) {
	for _, s := range confirmedRunnerSessions() {
		if s.Name == name {
			return s, true
		}
	}
	return RunnerPTYSession{}, false
}

// closeConfirmedRunnerSessions is the voice-safe "close all coding sessions"
// operation. The older administrative tmux_close_sessions tool intentionally
// closes every tmux session, including shells; a spoken lifecycle command must
// never inherit that blast radius.
func closeConfirmedRunnerSessions() []RunnerSessionCloseResult {
	sessions := confirmedRunnerSessions()
	results := make([]RunnerSessionCloseResult, 0, len(sessions))
	for _, s := range sessions {
		res := RunnerSessionCloseResult{Name: s.Name, Runner: s.Runner}
		if out, err := exec.Command(tmuxCmdName(), "kill-session", "-t", s.Name).CombinedOutput(); err != nil {
			res.Error = strings.TrimSpace(string(out))
			if res.Error == "" {
				res.Error = err.Error()
			}
		}
		results = append(results, res)
	}
	return results
}

// sessionChoices builds the picker payload from live runner sessions.
func sessionChoices(sessions []RunnerPTYSession) []RunnerSessionChoice {
	choices := make([]RunnerSessionChoice, 0, len(sessions))
	for i, s := range sessions {
		choices = append(choices, RunnerSessionChoice{
			Name:   s.Name,
			Runner: s.Runner,
			Index:  i,
		})
	}
	return choices
}
