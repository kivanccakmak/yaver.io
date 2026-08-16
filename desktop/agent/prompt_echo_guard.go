package main

// prompt_echo_guard.go — the Yaver prompt frame never reaches a human eye.
//
// THE COMPLAINT (2026-07-27, user's words): "in web UI / mobile UI, do NOT
// pollute the UI with our prefix prompt … Still pass it as the initial prompt
// prefix, but simply don't show it to the user; show what the user actually
// wrote."
//
// THE INVARIANT this file exists to hold:
//
//	what is STORED and DISPLAYED is what the user typed;
//	what is SENT to the runner may be framed.
//
// Most of that invariant is already true BY CONSTRUCTION, and it is worth
// naming why so nobody "fixes" it back:
//
//   - composeTurnPrompt (task_prompt_frame.go) runs at SPAWN time, on a local
//     variable. It never writes back to task.Title / task.Description /
//     task.Turns. So the persisted, user-visible fields hold the user's raw
//     words and always have.
//   - ConversationTurn.Content is seeded from opts.InitialUserPrompt (or the
//     description/title fallback) in CreateTaskWithOptions, BEFORE any framing
//     exists. Same for the follow-up turn appended in ContinueTask.
//
// There is exactly ONE way the frame can still reach a screen, and it is not a
// storage bug — it is an ECHO. Raw-mode runners (codex, and opencode in some
// modes) reproduce their entire stdin on stdout before answering. That echo is
// real runner output: it arrives on the same pipe as the answer, gets appended
// to task.Output, and streams live to every surface through TaskManager.emit.
// So on the phone, the web transcript, and the car readback, the first ~11 KB
// of a codex task was the Yaver preamble — verbatim, as if the assistant had
// said it.
//
// Until now that was only cleaned at COMPLETION (task.ResultText =
// stripPromptEcho(task.Output)). Which means the wall was on screen for the
// entire duration of the run — the whole time the user is actually watching.
//
// WHY A STREAM FILTER AND NOT A PER-VIEW STRIP. A per-view strip has to be
// ported to mobile, web, tvOS, watch, Wear, car and the CLI, and it drifts —
// that is the same defect shape as the .web.ts parity bugs. TaskManager.emit
// is the single choke point through which every byte of runner output reaches
// both task.Output (what polling surfaces read) and task.outputCh (what SSE +
// QUIC stream). Filtering there means no surface has to know the frame exists.
//
// WHY IT IS BOUNDED THREE WAYS. The guard withholds bytes, and a filter that
// can withhold forever is a silent product — the exact defect CLAUDE.md's
// snowball rule is about. So it disarms and flushes everything it held on the
// FIRST of:
//
//	1. the boundary sentinel arrives  → drop everything up to and including it
//	   (this is the success path: the echo is over, the answer starts here);
//	2. it has held more bytes than the prompt we actually sent, plus slack
//	   → this was never an echo, show it;
//	3. holdDeadline of wall-clock elapses → a depth/byte bound is not a
//	   wall-clock bound; a runner that dribbles must not be able to keep the
//	   screen blank.
//
// plus an unconditional flush() when the stream ends. A guard that has not
// been seen to fail is a guess, so TestPromptEchoGuardFlushesOnEveryBound
// breaks each bound in turn.

import (
	"strings"
	"time"
)

// promptEchoHoldWindow bounds how long the guard may withhold output waiting
// for the boundary sentinel. Runners echo stdin in the first milliseconds, so
// this is generous by two orders of magnitude; it exists so that "no sentinel
// ever arrives" degrades to "the user sees the output late" rather than
// "the user sees nothing, forever".
const promptEchoHoldWindow = 3 * time.Second

// promptEchoHoldSlack is added to the sent-prompt length to size the byte
// budget. Runners wrap the echo in their own scaffolding (codex's banner, the
// "Reading additional input from stdin…" hint, ANSI colour runs), so the echo
// is legitimately somewhat longer than what we sent.
const promptEchoHoldSlack = 8 * 1024

// promptEchoGuard suppresses a runner's verbatim echo of the Yaver-framed
// prompt so it never reaches task.Output or the live stream.
//
// Not safe for concurrent use; TaskManager.emit holds outputMu around it.
type promptEchoGuard struct {
	armed    bool
	pending  strings.Builder
	budget   int
	deadline time.Time
}

// newPromptEchoGuard arms a guard for a prompt we are about to send.
//
// Returns nil — a no-op guard — when there is nothing to guard against: an
// empty prompt, or a prompt with no boundary sentinel (raw runner commands
// pass through composeTurnPrompt unframed, and a frameless prompt has no wall
// to hide). A nil guard is explicitly supported by every method so callers
// never branch.
func newPromptEchoGuard(prompt string) *promptEchoGuard {
	if prompt == "" || !strings.Contains(prompt, promptEchoSentinel) {
		return nil
	}
	return &promptEchoGuard{
		armed:    true,
		budget:   len(prompt) + promptEchoHoldSlack,
		deadline: time.Now().Add(promptEchoHoldWindow),
	}
}

// filter takes one chunk of runner output and returns what may be shown.
//
// Returns "" while it is still holding. Once disarmed it is a pass-through, so
// the cost after the first flush is a single boolean test per chunk.
func (g *promptEchoGuard) filter(text string) string {
	if g == nil || !g.armed {
		return text
	}
	g.pending.WriteString(text)
	held := g.pending.String()

	// Bound 1 — the sentinel. composeTurnPrompt appends it as the LAST line of
	// every framed prompt, so LastIndex lands after any sentinel-wrapped
	// per-turn block (screen context wraps itself in the same sentinel) and
	// after the frame. Everything before it is our bytes, not the runner's.
	if idx := strings.LastIndex(held, promptEchoSentinel); idx >= 0 {
		g.disarm()
		return strings.TrimLeft(held[idx+len(promptEchoSentinel):], "\r\n")
	}

	// Bound 2 — bytes. More output than we could possibly have sent means this
	// is the runner talking, not repeating us.
	if len(held) > g.budget {
		g.disarm()
		return held
	}

	// Bound 3 — wall clock. Checked here rather than with a timer because a
	// timer that fires with nothing to write is a no-op anyway; flush() covers
	// the case where no further chunk ever arrives.
	if time.Now().After(g.deadline) {
		g.disarm()
		return held
	}

	return ""
}

// flush releases anything still held. Called unconditionally when the runner's
// stdout/stderr close, so a stream that ended mid-echo cannot strand output.
func (g *promptEchoGuard) flush() string {
	if g == nil || !g.armed {
		return ""
	}
	held := g.pending.String()
	g.disarm()
	return held
}

func (g *promptEchoGuard) disarm() {
	g.armed = false
	g.pending.Reset()
}
