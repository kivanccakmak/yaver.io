/**
 * promptFraming.ts — the web half of "the user never sees our prompt header".
 *
 * Yaver wraps a user's message in a preamble before handing it to a runner
 * (source contract, decision policy, wrapper capabilities, dev-server rules,
 * boundary sentinel). That frame is a TRANSPORT artifact — a packet header, in
 * the user's own words — and the agent now keeps it out of everything a client
 * can read: it is built in a local variable at spawn time, producers that add
 * scaffolding put it on a transport-only field with no counterpart on the wire
 * DTO, and a raw-mode runner's verbatim ECHO of it is dropped before it reaches
 * task.Output (desktop/agent/prompt_echo_guard.go).
 *
 * Web had NO strip at all — not one line, in either transcript surface — which
 * is why the wall was most visible here. VibeCodingView rendered the raw
 * `task.output` through `stripAnsi` alone, and RuntimeLabView fed the same raw
 * lines to `SpeechSynthesisUtterance`, so the browser read the preamble out
 * loud.
 *
 * With the agent fixed, this module is a FALLBACK for the two cases the agent
 * fix cannot reach: a dashboard talking to an OLDER agent (the web app deploys
 * independently of anyone's box), and tasks already persisted with a polluted
 * stream.
 *
 * MUST stay in sync with `systemContextEndMarkers` / `promptEchoSentinel` in
 * desktop/agent/result_cleanup.go and with mobile/src/lib/promptFraming.ts.
 * mobile/src/lib/promptFramingParity.test.ts reads the Go source and fails on
 * drift; promptFraming.test.ts below pins this copy to the same values.
 */

/** Appended as the LAST line of every framed prompt by the agent. */
export const YAVER_PROMPT_BOUNDARY = "⟦YAVER_PROMPT_BOUNDARY_9F3A⟧";

/** Last sentence of each agent-injected context block (pre-sentinel agents). */
export const SYSTEM_CONTEXT_END_MARKERS = [
  YAVER_PROMPT_BOUNDARY,
  "Kill any stale expo/metro processes before retrying.",
  "or related Yaver preview tools instead of asking them to guess.",
  "pick up where you left off.",
];

/**
 * Slice after the LAST frame boundary present in `content`.
 *
 * LAST, not first: per-turn context blocks wrap themselves in the same
 * sentinel, so an early match would leave the rest of the frame on screen.
 * Returns the input unchanged when no boundary is present — truncating a real
 * answer is a worse bug than the one this fixes.
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
 * Used to gate the browser read-aloud path: reciting "[Yaver wrapper
 * capabilities] You are running inside Yaver, not a generic terminal…" is the
 * worst shape of this bug, and silence is the better failure — the text is
 * still on screen either way.
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
