package main

// task_parked_turn.go — holding a follow-up that could not run yet, and running it
// once it can.
//
// THE INCIDENT (2026-08-02). The user was on holiday, driving tasks from the phone
// against a remote box. A task finished; they typed a follow-up to keep vibing in the
// same session; Codex's credential had gone stale. The follow-up was spent on a spawn
// that could only fail, and the words were gone. Re-authenticating — which worked —
// did not bring the turn back, because nothing had kept it.
//
// So the cost of an expiry was never 30 seconds of OAuth. It was the conversation.
//
// THE RULE THIS ENCODES: never consume a user's prompt on an operation you already
// know cannot succeed. Park it, say it is parked, and replay it — into the SAME
// session — the moment the blocker clears. A prompt is user work; losing it is a data
// loss bug wearing the costume of an auth error.
//
// Scope is deliberately small. One parked turn per task (a second follow-up replaces
// the first — the user's latest intent wins, and a queue of stale prompts firing at
// once is its own bug). Memory-only: a parked turn is worth surviving a re-auth, not
// worth surviving an agent restart, and persisting user prompt text to disk would
// invite exactly the kind of storage the privacy contract keeps us out of.

import (
	"log"
	"strings"
	"sync"
	"time"
)

// parkedTurn is a follow-up waiting for its blocker to clear.
type parkedTurn struct {
	TaskID   string
	Input    string
	Images   []ImageAttachment
	Opts     TaskResumeOptions
	ParkedAt time.Time
	// Reason is why it could not run, in the user's language. Rendered by the
	// surfaces beside the one button that fixes it.
	Reason string
	Code   string
}

// parkedTurnTTL bounds how long a prompt waits. Past this it is stale intent: the
// user has moved on, and firing a two-hour-old instruction into a session is worse
// than dropping it. Replay is a courtesy with a short memory.
const parkedTurnTTL = 2 * time.Hour

var parkedTurns = struct {
	sync.Mutex
	byTask map[string]parkedTurn
}{byTask: map[string]parkedTurn{}}

// ParkPendingTurn stores a follow-up that could not be dispatched. Returns true when
// it was parked, so the HTTP layer can promise the user their words were kept —
// never claim a park that did not happen.
func (tm *TaskManager) ParkPendingTurn(taskID, input string, images []ImageAttachment, opts TaskResumeOptions) bool {
	taskID = strings.TrimSpace(taskID)
	if taskID == "" || strings.TrimSpace(input) == "" {
		return false
	}
	parkedTurns.Lock()
	defer parkedTurns.Unlock()
	parkedTurns.byTask[taskID] = parkedTurn{
		TaskID:   taskID,
		Input:    input,
		Images:   images,
		Opts:     opts,
		ParkedAt: time.Now(),
	}
	return true
}

// ParkedTurnFor returns the parked turn for a task, if it is still live.
func ParkedTurnFor(taskID string) (parkedTurn, bool) {
	parkedTurns.Lock()
	defer parkedTurns.Unlock()
	t, ok := parkedTurns.byTask[strings.TrimSpace(taskID)]
	if !ok {
		return parkedTurn{}, false
	}
	if time.Since(t.ParkedAt) > parkedTurnTTL {
		delete(parkedTurns.byTask, t.TaskID)
		return parkedTurn{}, false
	}
	return t, true
}

// dropParkedTurn removes a parked turn (replayed, expired, or superseded).
func dropParkedTurn(taskID string) {
	parkedTurns.Lock()
	delete(parkedTurns.byTask, strings.TrimSpace(taskID))
	parkedTurns.Unlock()
}

// takeReplayableTurns removes and returns every live parked turn. Taking them under
// the lock means a concurrent replay cannot double-fire the same prompt — the second
// caller finds nothing, which is exactly right.
func takeReplayableTurns() []parkedTurn {
	parkedTurns.Lock()
	defer parkedTurns.Unlock()
	var out []parkedTurn
	for id, t := range parkedTurns.byTask {
		if time.Since(t.ParkedAt) > parkedTurnTTL {
			delete(parkedTurns.byTask, id)
			continue
		}
		out = append(out, t)
		delete(parkedTurns.byTask, id)
	}
	return out
}

// ReplayParkedTurns re-dispatches everything that was waiting on runner auth.
//
// Called from the one place that proves the blocker is gone: a successful credential
// renewal or a completed sign-in. Deliberately NOT called on a timer — replaying on a
// guess would fire the user's words into a session that still cannot serve them, and
// then they really would be gone.
func (tm *TaskManager) ReplayParkedTurns(reason string) {
	turns := takeReplayableTurns()
	if len(turns) == 0 {
		return
	}
	for _, t := range turns {
		waited := time.Since(t.ParkedAt).Round(time.Second)
		if _, err := tm.ResumeTaskWithOptions(t.TaskID, t.Input, t.Images, t.Opts); err != nil {
			// Re-park: the blocker we thought had cleared has not, and the prompt
			// is still the user's. Losing it on the recovery path would be the
			// original bug with extra steps.
			tm.ParkPendingTurn(t.TaskID, t.Input, t.Images, t.Opts)
			log.Printf("[parked-turn] task %s: replay failed after %s (%s) — kept parked: %v", t.TaskID, waited, reason, err)
			continue
		}
		log.Printf("[parked-turn] task %s: replayed follow-up after %s (%s)", t.TaskID, waited, reason)
	}
}

// replayParkedTurnsAfterAuthRecovery is the seam the credential paths call. It is a
// free function so runner_auth_refresh.go and the browser-auth completion path do not
// need a TaskManager reference threaded to them.
var replayParkedTurnsAfterAuthRecovery = func(reason string) {}

// registerParkedTurnReplay wires a TaskManager into the seam above. Called once at
// agent start.
func registerParkedTurnReplay(tm *TaskManager) {
	if tm == nil {
		return
	}
	replayParkedTurnsAfterAuthRecovery = func(reason string) {
		// Off the caller's goroutine: a renewal happening inside a keep-alive tick
		// must not wait on task dispatch.
		go tm.ReplayParkedTurns(reason)
	}
}
