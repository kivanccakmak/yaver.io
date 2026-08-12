package main

// dom_inspect_turn.go — the element the user clicked in the preview, attached
// to EVERY turn of a conversation rather than only the first.
//
// Same reasoning as screen_context_turn.go: "deep audit this element" or "the
// spacing on this card is wrong" is a thing people say on turn 3, after they
// have looked around the preview — never turn 1. Registered as a per-turn hook
// it rides the follow-up path too.
//
// All the same deliberate choices carry over:
//
//   - NOT gated on Source. A selection is a selection whether the user is on
//     web, phone, or a car HUD. The gate that matters lives inside the store:
//     an element exists only if a surface reported it, and it is served only
//     while it is fresh.
//   - Opting out happens at the SOURCE — the surface stops DOM mode and
//     clears what it already reported (DELETE /dom-inspect) — so "off" means
//     the agent is not holding the user's element at all.
//   - Raw runner commands never see it: composeTurnPrompt returns before any
//     hook runs.
import (
	"log"
	"time"
)

func init() {
	registerPerTurnContext(func(task *Task, contextDir string) string {
		d, ok := globalDomElements.Get(contextDir, time.Now())
		if !ok {
			return ""
		}
		block := FormatDomElementBlock(d)
		if block == "" {
			return ""
		}
		log.Printf("[task %s] DOM element context attached: %s", task.ID, d.Summary())
		return block
	})
}
