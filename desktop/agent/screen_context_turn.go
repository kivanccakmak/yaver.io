package main

// screen_context_turn.go — the screen the user is looking at, attached to
// EVERY turn of a conversation rather than only the first.
//
// This started life inline in startProcess. It belongs here for one reason
// that is not stylistic: startProcess only runs for a NEW runner process, so
// an inline block reaches turn 1 and nothing else — and "make this screen red"
// is a thing people say on turn 3, after they have looked around the preview.
// Registered as a per-turn hook it rides the follow-up path too, which is the
// turn where it actually earns its bytes.
//
// It is also the reason the composer takes per-turn hooks at all rather than a
// second function prepending to the same prompt. Screen context is genuinely
// per-turn (the screen changes); the Yaver preamble is genuinely per-session
// (the runner already read it). One composer, two lifetimes, no race — see
// task_prompt_frame.go.
//
// Everything else about the original block is preserved deliberately:
//
//   - NOT gated on Source. A live preview is a live preview whether the user is
//     on web, phone, or a car HUD, and gating on source is how several context
//     blocks in this repo ended up reaching one surface each. The gate that
//     matters lives inside the store: a context exists only if a surface
//     reported it, and it is served only while it is fresh.
//   - Opting out happens at the SOURCE — the surface stops reporting and clears
//     what it already reported (DELETE /screen-context) — so "off" means the
//     agent is not holding the user's screen at all, rather than holding it and
//     promising not to look.
//   - Raw runner commands never see it: composeTurnPrompt returns before any
//     hook runs, because `/exit` with a context block in front is not `/exit`.

import (
	"log"
	"time"
)

func init() {
	registerPerTurnContext(func(task *Task, contextDir string) string {
		sc, ok := globalScreenContexts.Get(contextDir, time.Now())
		if !ok {
			return ""
		}
		block := FormatScreenContextBlock(sc)
		if block == "" {
			return ""
		}
		log.Printf("[task %s] screen context attached: %s", task.ID, sc.Summary())
		return block
	})
}
