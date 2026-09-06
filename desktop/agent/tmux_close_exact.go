package main

// Exact tmux lifecycle operations shared by UI surfaces.
//
// The administrative /runner/sessions/close route intentionally kills every
// tmux session. It must never back a per-row trash button. A row carries both
// the human-readable name and tmux's current session id; requiring them to
// agree prevents a delayed client action from killing a newly-created session
// that reused the old name.

import (
	"fmt"
	"os/exec"
	"strings"
	"time"
)

type exactTmuxCloseResult struct {
	OK            bool   `json:"ok"`
	Code          string `json:"code"`
	SessionName   string `json:"sessionName,omitempty"`
	SessionID     string `json:"sessionId,omitempty"`
	Verified      bool   `json:"verified"`
	AlreadyClosed bool   `json:"alreadyClosed,omitempty"`
}

func listTmuxSessionIdentities() (map[string]string, map[string]string, error) {
	byName := map[string]string{}
	byID := map[string]string{}
	if !tmuxAvailable() {
		return byName, byID, nil
	}
	out, err := exec.Command(tmuxCmdName(), "list-sessions", "-F", "#{session_name}\t#{session_id}").CombinedOutput()
	if err != nil {
		if isTmuxNoServer(string(out)) {
			return byName, byID, nil
		}
		return nil, nil, fmt.Errorf("list tmux sessions: %w: %s", err, strings.TrimSpace(string(out)))
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "\t", 2)
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			continue
		}
		byName[parts[0]] = parts[1]
		byID[parts[1]] = parts[0]
	}
	return byName, byID, nil
}

// CloseExactSession kills exactly one tmux session and verifies that the same
// identity disappeared before acknowledging the caller. Repeating a request
// after a successful close is idempotent. A reused name with a different tmux
// id is an identity conflict, never permission to kill the replacement.
func (m *TmuxManager) CloseExactSession(sessionName, sessionID string) (exactTmuxCloseResult, error) {
	name := strings.TrimSpace(sessionName)
	id := strings.TrimSpace(sessionID)
	result := exactTmuxCloseResult{SessionName: name, SessionID: id}
	if name == "" || id == "" {
		return result, fmt.Errorf("sessionName and sessionId are required")
	}

	byName, byID, err := listTmuxSessionIdentities()
	if err != nil {
		return result, err
	}
	currentID, nameExists := byName[name]
	currentName, idExists := byID[id]
	if !nameExists && !idExists {
		result.OK = true
		result.Code = "already_closed"
		result.Verified = true
		result.AlreadyClosed = true
		return result, nil
	}
	if !nameExists || !idExists || currentID != id || currentName != name {
		result.Code = "identity_mismatch"
		return result, fmt.Errorf("tmux session identity changed; refresh before closing it")
	}

	if out, killErr := exec.Command(tmuxCmdName(), "kill-session", "-t", id).CombinedOutput(); killErr != nil {
		// The process may have disappeared between the inventory and kill. Probe
		// again before calling that a failure.
		afterName, afterID, probeErr := listTmuxSessionIdentities()
		if probeErr == nil && afterName[name] == "" && afterID[id] == "" {
			result.OK = true
			result.Code = "closed"
			result.Verified = true
		} else {
			result.Code = "close_failed"
			return result, fmt.Errorf("close tmux session: %w: %s", killErr, strings.TrimSpace(string(out)))
		}
	} else {
		deadline := time.Now().Add(2 * time.Second)
		for {
			afterName, afterID, probeErr := listTmuxSessionIdentities()
			if probeErr == nil && afterName[name] == "" && afterID[id] == "" {
				result.OK = true
				result.Code = "closed"
				result.Verified = true
				break
			}
			if time.Now().After(deadline) {
				result.Code = "close_failed"
				return result, fmt.Errorf("tmux session is still present after close")
			}
			time.Sleep(25 * time.Millisecond)
		}
	}

	if m != nil && m.taskMgr != nil {
		m.detachAdoptedSessionTasks(name)
		m.taskMgr.markTmuxSessionClosed(name)
	}
	requestConvexLifecycleSync()
	return result, nil
}

// markTmuxSessionClosed reconciles task lifecycle after an exact raw-session
// close. A Review/Ready card cannot keep claiming a resumable conversation
// after its seat was verified absent.
func (tm *TaskManager) markTmuxSessionClosed(sessionName string) {
	if tm == nil || strings.TrimSpace(sessionName) == "" {
		return
	}
	now := time.Now()
	changed := false
	tm.mu.Lock()
	defer tm.mu.Unlock()
	for _, task := range tm.tasks {
		if task == nil || task.DeletedAt != nil || strings.TrimSpace(task.TmuxSession) != sessionName {
			continue
		}
		switch task.Status {
		case TaskStatusQueued, TaskStatusRunning, TaskStatusReady, TaskStatusReview:
			task.Status = TaskStatusStopped
			task.FinishedAt = &now
			if task.doneCh != nil {
				select {
				case <-task.doneCh:
				default:
					close(task.doneCh)
				}
			}
			changed = true
		}
	}
	if changed {
		tm.persist()
	}
}
