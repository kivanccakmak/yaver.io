/**
 * promptFraming.ts — the client-side half of "the user never sees our prompt
 * header".
 *
 * THE RULE, and where it is actually enforced. Yaver wraps a user's message in
 * a preamble before handing it to a runner (source contract, decision policy,
 * wrapper capabilities, dev-server rules, boundary sentinel). That frame is a
 * TRANSPORT artifact — like a packet header. The agent now keeps it entirely
 * out of what it stores and streams:
 *
 *   - the framed string is built at spawn time in a local variable
 *     (desktop/agent/task_prompt_frame.go) and never written to a stored field;
 *   - producers that add their own scaffolding put it on
 *     TaskCreateOptions.PromptText, which has no counterpart on the wire DTO;
 *   - a raw-mode runner's verbatim ECHO of the frame is dropped before it
 *     reaches task.Output or the live stream
 *     (desktop/agent/prompt_echo_guard.go).
 *
 * So on a current agent nothing here has anything to do. This module exists for
 * the two cases where that is not true:
 *
 *   1. an OLDER agent the phone is talking to (the app ships independently of
 *      the box, and a user's Mac mini can be many versions behind);
 *   2. tasks already persisted with a polluted stream.
 *
 * WHY IT IS ONE MODULE. There were THREE copies of this logic in the app —
 * `app/(tabs)/tasks.tsx`, `src/components/FeedbackOverlay.tsx`, and the Go
 * original — and they had already drifted: the tasks.tsx marker list never
 * learned about the boundary sentinel, and FeedbackOverlay's copy had no marker
 * slicing at all. Drift between duplicated cleanup is exactly how the frame
 * kept reaching the screen on one surface while the others looked fine.
 * promptFramingParity.test.ts reads the Go source and fails when the lists
 * disagree.
 */

/**
 * Appended as the LAST line of every framed prompt by the agent, and wrapped
 * around each per-turn context block. A runner that echoes stdin reproduces it
 * verbatim, which gives us a deterministic place to slice.
 *
 * MUST equal `promptEchoSentinel` in desktop/agent/result_cleanup.go.
 */
export const YAVER_PROMPT_BOUNDARY = "⟦YAVER_PROMPT_BOUNDARY_9F3A⟧";

/**
 * The last sentence of each agent-injected context block, used as a fallback
 * boundary for agents old enough to predate the sentinel.
 *
 * MUST equal `systemContextEndMarkers` in desktop/agent/result_cleanup.go.
 */
export const SYSTEM_CONTEXT_END_MARKERS = [
  YAVER_PROMPT_BOUNDARY,
  "Kill any stale expo/metro processes before retrying.",
  "or related Yaver preview tools instead of asking them to guess.",
  "pick up where you left off.",
];

/**
 * Slice after the LAST context-block boundary present in `content`.
 *
 * LAST, not first: the screen-context block wraps itself in the same sentinel,
 * so an early match would leave the rest of the frame on screen. Returns the
 * input unchanged when no boundary is present — a runner that never echoed
 * must never have its answer truncated.
 */
export function sliceAfterFrameBoundary(content: string): string {
  if (!content) return content;
  let best = -1;
  for (const marker of SYSTEM_CONTEXT_END_MARKERS) {
    const idx = content.lastIndexOf(marker);
    if (idx >= 0 && idx + marker.length > best) best = idx + marker.length;
  }
  return best > 0 ? content.slice(best) : content;
}

/**
 * True when a string still carries visible Yaver framing.
 *
 * Used by the voice/readback paths: speaking "[Yaver wrapper capabilities] You
 * are running inside Yaver, not a generic terminal…" to someone driving is the
 * worst shape of this bug, and a silent skip is better than that.
 */
export function containsYaverFraming(text: string): boolean {
  if (!text) return false;
  return (
    text.includes(YAVER_PROMPT_BOUNDARY) ||
    text.includes("[Yaver wrapper capabilities]") ||
    text.includes("[Yaver — decision policy]") ||
    text.includes("[Yaver Agent Context]") ||
    text.includes("[SECURITY CONTEXT — GUEST SESSION]")
  );
}
