package main

// task_prompt_frame.go — ONE function decides what wraps a user's message
// before it reaches a runner.
//
// THE RULE: the Yaver preamble rides the FIRST message a runner PROCESS sees.
// Every later turn in that same process passes the user's words through
// essentially verbatim.
//
// Why this file exists. The preamble is large and it is *correct* — the
// response contract, the decision policy, the wrapper capabilities, the
// dev-server transport rules and the yaver-action sentinel are what make a
// generic CLI behave like it is inside Yaver. But it is also SESSION-CONSTANT:
// once a runner has read it, the words are in that process's context and stay
// there for the rest of the conversation. Re-sending it on turn 2 buys nothing
// and costs everything:
//
//   - measured on this repo, the assembled first-turn frame for a mobile task
//     is ~11 KB / ~2.7k tokens (see TestFollowUpSavesMostOfThePrompt);
//   - a real follow-up is "now make it red" — 16 bytes. Re-wrapping it means
//     >99% of what we ship is boilerplate the runner already read;
//   - and it BURIES the ask. The user's actual words end up as one short line
//     under two thousand words of instructions, which is a correctness problem
//     before it is a cost problem.
//
// So the frame is split in two, and the split is the whole design:
//
//	ARMED (first message of a runner session, or a cold spawn)
//	  source response contract · decision / scheduling policy · ask mode ·
//	  wrapper capabilities · slice contract · dev-server rules ·
//	  viewport hint · verbosity · yaver-action sentinel instructions
//
//	PER-TURN (every message, always)
//	  attachment paths (data the runner cannot discover on its own) ·
//	  registered per-turn context (see registerPerTurnContext) ·
//	  PII redaction · the prompt-echo boundary sentinel
//
// Nothing else survives into a follow-up. If you are about to add a block
// here, the test is: "would the runner already know this from turn 1?" If yes
// it is ARMED; if it can change between two messages of one conversation
// (an attachment, the screen the user is now looking at) it is PER-TURN.
//
// WHEN A FOLLOW-UP RE-ARMS. Not from a UI-level guess about "is this the first
// message" — from whether the process we are about to spawn actually carries
// the earlier turns. resumeCanCarryContext (agent_runner_resume.go) is the
// single oracle, shared with resumeTransform so the argv we build and the
// preamble decision can never disagree. A claude/codex follow-up with no
// captured session id, a runner switch, a crash restart and a fork all start a
// COLD process — and a cold runner that never read the preamble does not know
// it is inside Yaver, cannot drive the dev server, and answers a phone with
// desktop-shaped markdown. Getting this backwards in either direction is a
// defect: re-arm too eagerly and we are back to paying for the preamble every
// turn; re-arm too rarely and the runner is silently mis-briefed.

import (
	"fmt"
	"log"
	"strings"
)

// promptFramePolicy is the input to composeTurnPrompt: the two facts that
// decide the shape of a turn, plus the two escape hatches that suppress the
// Yaver framing entirely.
type promptFramePolicy struct {
	// ArmPreamble is true when the runner process about to read this text has
	// NOT already read the Yaver preamble — the first message of a session, a
	// cold spawn after a crash, a runner switch, or a resume the CLI cannot
	// actually resume. Decided by resumeCanCarryContext, never by the caller's
	// intuition.
	ArmPreamble bool

	// RawRunnerCommand marks a runner-native slash command (/goal, /exit,
	// /resume …). These must reach the CLI byte-for-byte apart from leading
	// whitespace — any Yaver block changes runner behaviour — so they get no
	// frame at all, not even the boundary sentinel.
	RawRunnerCommand bool

	// ChatMode marks the EMBEDDED lane: a third party (Talos web chat /
	// WhatsApp / voice) driving Yaver as a plain-language Q&A brain for a
	// non-technical end user. That user must never see coding-agent framing,
	// so chat mode swaps the whole armed frame for its own clean contract.
	ChatMode string
}

// perTurnContextHook renders context that is true only of THIS turn. Returns
// "" when it has nothing honest to say.
//
// This is the seam for context that legitimately changes between two messages
// of one conversation — the screen the user is looking at right now is the
// motivating case. Such a block MUST be compact and self-delimited (wrap it in
// promptEchoSentinel so stripPromptEcho can slice it back out and it can never
// surface as if the user had typed it), and it must be opt-outable at the
// SOURCE: the honest way to turn it off is for the surface to stop reporting,
// not for this function to hold the data and promise not to look.
type perTurnContextHook func(task *Task, contextDir string) string

var perTurnContextHooks []perTurnContextHook

// registerPerTurnContext adds a hook. Call it from an init() in the file that
// owns the context, so a new source of per-turn context lands without editing
// the composer — and so there is exactly one composer rather than two
// functions racing to prepend to the same prompt.
//
// The screen-context work in flight (screen_context.go, uncommitted at the time
// this landed) plugs in with exactly this, and nothing in tasks.go:
//
//	func init() {
//		registerPerTurnContext(func(task *Task, contextDir string) string {
//			sc, ok := globalScreenContexts.Get(contextDir, time.Now())
//			if !ok {
//				return ""
//			}
//			return FormatScreenContextBlock(sc)
//		})
//	}
//
// Registering it here rather than inlining it in startProcess is what makes it
// reach FOLLOW-UPS too — which is the turn where "make this screen red" is
// actually said, and the turn the inline version missed.
func registerPerTurnContext(h perTurnContextHook) {
	if h != nil {
		perTurnContextHooks = append(perTurnContextHooks, h)
	}
}

// isChatTaskMode reports whether the runner mode selects the embedded chat
// contract. Surface is encoded as a suffix ("chat:whatsapp", "chat:voice").
func isChatTaskMode(mode string) bool {
	return mode == "chat" || strings.HasPrefix(mode, "chat:")
}

// composeTurnPrompt assembles the exact bytes a runner receives for one turn.
//
// It is the ONLY place that wraps a user's message. startProcess (first turn /
// cold spawn) and startResume (follow-up) both call it; they differ in exactly
// one input, ArmPreamble.
func (tm *TaskManager) composeTurnPrompt(task *Task, userText string, p promptFramePolicy) string {
	// Runner-native commands pass through untouched. Deliberately BEFORE
	// everything, including the sentinel: `/exit` with a trailing sentinel is
	// not `/exit`.
	if p.RawRunnerCommand {
		return strings.TrimLeft(userText, " \t\r\n")
	}

	contextDir := tm.workDir
	if strings.TrimSpace(task.WorkDir) != "" {
		contextDir = task.WorkDir
	}

	prefix := ""
	prompt := userText

	if p.ArmPreamble {
		if p.ChatMode != "" {
			// Embedded chat gets its own clean contract and NONE of the
			// coding-agent context blocks — "operate autonomously" and
			// "schedule_self" framing is wrong for a conversational turn, and
			// "[Yaver wrapper capabilities]" in front of a non-technical end
			// user is the leak this lane exists to prevent.
			prompt += chatTaskResponseContext(p.ChatMode)
		} else {
			prompt += tm.armedSystemFrame(task, contextDir)
			prefix = armedSystemPrefix(task)
		}
		// Output shaping is neutral between the two lanes — it describes the
		// screen the answer lands on, not the agent's job — so it rides both.
		prompt += armedOutputShape(task)
	}

	// ---- per-turn, every message ------------------------------------------

	for _, hook := range perTurnContextHooks {
		if block := hook(task, contextDir); block != "" {
			prompt += block
		}
	}

	// Attachment paths are DATA the runner cannot discover on its own, and a
	// follow-up is exactly when new ones arrive — so this rides every turn.
	if len(task.ImagePaths) > 0 {
		prompt += "\n\n[Attached images — use the Read tool to examine these files]\n"
		for i, path := range task.ImagePaths {
			prompt += fmt.Sprintf("Image %d: %s\n", i+1, path)
		}
	}

	prompt = prefix + prompt

	// Company dataPolicy.redactPII: scrub the fully-assembled prompt as the
	// LAST step before it reaches the runner. Per-turn because the user's own
	// follow-up text is exactly what needs scrubbing. No-op unless the task is
	// under a redaction policy.
	if task.RedactPII {
		if redacted, n := RedactPII(prompt); n > 0 {
			log.Printf("[task %s] dataPolicy.redactPII: scrubbed %d PII/secret span(s) from prompt", task.ID, n)
			prompt = redacted
		}
	}

	// The prompt-echo boundary. The ONE piece of Yaver framing that is
	// genuinely per-turn: runners like codex echo the whole prompt to stdout
	// before answering on EVERY turn, and stripPromptEcho needs a deterministic
	// last occurrence to slice after. 26 bytes, and without it a follow-up's
	// echo lands in ResultText as if the assistant had said it.
	prompt += "\n\n" + promptEchoSentinel + "\n"

	return prompt
}

// armedSystemPrefix is the part of the armed frame that must lead the prompt
// rather than trail it.
//
// The yaver-action sentinel instruction teaches the runner it can emit
// `<<yaver-action: reload <slug>>>` to drive the user's paired phone. Only
// relevant when the user is actually talking through the mobile app — a CLI or
// autodev session has no phone to talk to and does not need the noise. It is
// prepended rather than threaded as a runner flag because codex and opencode
// have no clean --append-system-prompt; one channel for all runners keeps the
// dispatch path simple.
func armedSystemPrefix(task *Task) string {
	if task.Source == "mobile" || task.Source == "mobile-code" {
		return YaverActionSystemPrompt + "\n\n---\n\n"
	}
	return ""
}

// armedSystemFrame is everything a runner needs to hear ONCE per session.
//
// Order is load-bearing: the source-specific framing is read first, then the
// policy clarifies "and don't ask in prose", then the capability blocks.
func (tm *TaskManager) armedSystemFrame(task *Task, contextDir string) string {
	var sb strings.Builder

	sb.WriteString(taskSourcePromptSuffix(task.Source))

	switch {
	case task.AskMode:
		// Ask mode reframes the run as explain-first deep analysis with a
		// confirm gate before acting — the opposite stance from the
		// no-questions preamble, so it replaces (not augments) it.
		sb.WriteString(askModePreamble())
	case !task.AskFreely:
		project := DetectProjectInfo(contextDir).Name
		sb.WriteString(noQuestionsPreamble(renderVaultHintsForTask(currentRuntimeVaultStore(), project)))
		// Runner-agnostic "future work" contract: confirm cadence, then
		// schedule_self instead of looping. Skipped for scheduler-spawned runs
		// so a recurring task doesn't keep re-proposing its own schedule.
		if task.Source != "scheduler" {
			sb.WriteString(schedulingPreamble())
		}
	}

	// "mobile-code" is the mobile UI's "yaver code mode" toggle: same /tasks
	// endpoint, same TaskManager, but the runner sees the terminal-style prompt
	// prefix instead of the mobile dev-server hot-reload prefix.
	if sourceWantsWrapperCapabilities(task.Source) {
		sb.WriteString(yaverWrapperCapabilityContext(contextDir, task.Source))
	}

	sb.WriteString(formatTaskSliceContract(task.SliceContract))

	// Only mobile-style tasks need the dev-server transport instructions.
	// "mobile-code" deliberately skips this — it wants CLI-style runner output,
	// not the Hermes / Metro / dev-server scaffold.
	if task.Source == "mobile" {
		sb.WriteString(yaverDevServerContext(contextDir))
	}

	return sb.String()
}

// armedOutputShape is the viewport + verbosity pair: what surface this output
// will be read on (HUD vs desktop vs tmux split vs voice readback) and how long
// the human wants the answer. Both are set at task creation and constant for the
// session, so they ride the armed frame and never a follow-up.
func armedOutputShape(task *Task) string {
	var sb strings.Builder
	if vp := task.TaskViewport; vp != nil {
		sb.WriteString(formatViewportHint(vp))
	}
	if vc := task.TaskVerbosity; vc != nil && vc.Verbosity != nil {
		sb.WriteString(verbosityHint(*vc.Verbosity))
	}
	return sb.String()
}

// sourceWantsWrapperCapabilities lists the sources whose runner is a general
// terminal agent that must be told Yaver is not a generic shell.
func sourceWantsWrapperCapabilities(source string) bool {
	switch source {
	case "mcp", terminalLocalTaskSource, terminalRemoteTaskSource,
		"attach", "cli", "console", "connect", "mobile-code", "ask", "voice":
		return true
	}
	return false
}

// verbosityHint renders the 0-10 response-length preference.
func verbosityHint(v int) string {
	switch {
	case v <= 2:
		return fmt.Sprintf("\n[Verbosity: %d/10] The user prefers very brief responses. Just confirm what was done, report any errors, skip all implementation details.", v)
	case v <= 4:
		return fmt.Sprintf("\n[Verbosity: %d/10] The user prefers concise responses. Summarize what you did in 2-3 sentences.", v)
	case v <= 6:
		return fmt.Sprintf("\n[Verbosity: %d/10] The user prefers moderate detail. Show key changes, explain reasoning briefly.", v)
	case v <= 8:
		return fmt.Sprintf("\n[Verbosity: %d/10] The user wants detailed responses. Show code changes, explain your approach.", v)
	default:
		return fmt.Sprintf("\n[Verbosity: %d/10] The user wants full detail. Stream everything: all code changes, diffs, reasoning, alternatives.", v)
	}
}
