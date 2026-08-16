package main

import (
	"strings"
	"testing"
	"time"
)

// TestScreenContextReachesFollowUpTurns is the point of moving the screen-context
// injection out of startProcess and into a per-turn hook.
//
// startProcess only runs for a NEW runner process, so the inline version reached
// turn 1 and nothing after it — while "make THIS screen red" is what a user says
// on turn 3, after they have clicked around the preview. A context block that is
// only correct on the one turn where the user has not looked at anything yet is
// the inverted version of the bug this whole lane exists to fix.
func TestScreenContextReachesFollowUpTurns(t *testing.T) {
	tm := framedTestManager(t)
	task := framedMobileTask(tm)
	task.SessionID = "sess-1" // a real, resumable session → follow-up, not a cold spawn

	now := time.Now()
	globalScreenContexts.Put(ScreenContext{
		WorkDir: tm.workDir,
		Route:   "/settings",
		Heading: "Notification settings",
	}, now)
	t.Cleanup(func() { globalScreenContexts.Clear(tm.workDir) })

	followUp := tm.composeTurnPrompt(task, "make this red", promptFramePolicy{ArmPreamble: false})
	if !strings.Contains(followUp, "Notification settings") {
		t.Fatalf("a follow-up lost the screen the user is looking at:\n%s", followUp)
	}
	// Still the user's words plus one bounded, self-delimited block — not the
	// preamble sneaking back in under a different name.
	if strings.Contains(followUp, "[Yaver — decision policy]") {
		t.Error("the per-turn hook must not drag the session preamble along with it")
	}
	if len(followUp) > 600 {
		t.Errorf("per-turn context is %d bytes; it must stay compact enough to ride every turn", len(followUp))
	}
}

// TestScreenContextNeverTouchesARawRunnerCommand — `/exit` with a context block
// in front of it is not `/exit`.
func TestScreenContextNeverTouchesARawRunnerCommand(t *testing.T) {
	tm := framedTestManager(t)
	task := framedMobileTask(tm)

	globalScreenContexts.Put(ScreenContext{
		WorkDir: tm.workDir,
		Route:   "/settings",
		Heading: "Notification settings",
	}, time.Now())
	t.Cleanup(func() { globalScreenContexts.Clear(tm.workDir) })

	got := tm.composeTurnPrompt(task, "/exit", promptFramePolicy{ArmPreamble: false, RawRunnerCommand: true})
	if got != "/exit" {
		t.Fatalf("runner-native command was rewritten: %q", got)
	}
}
