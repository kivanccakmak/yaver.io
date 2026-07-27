/**
 * composerKeys.ts — the pure decision seam for "what does Enter mean in a
 * chat composer".
 *
 * Incident 2026-07-27 (production yaver.io, Vibing → Runtime composer): a user
 * typed line 1, pressed Enter to start line 2, and the message went out with
 * only line 1 — the second line looked "removed". The handler was
 *
 *     if (event.key === "Enter" && !event.shiftKey) { preventDefault(); send(); }
 *
 * which is two bugs stacked:
 *
 *  1. **No IME guard.** While an input method is composing (Turkish/CJK/dictation
 *     on some stacks) the browser fires `keydown` with `key === "Enter"` and
 *     `isComposing === true` to COMMIT the candidate, not to submit. Old
 *     browsers signal the same state as `keyCode === 229`. Sending there both
 *     submits a half-composed string and eats the keystroke the user meant for
 *     the text.
 *  2. **Shift was the ONLY escape hatch.** Anyone reaching for the newline
 *     chord they use elsewhere (Alt/Option+Enter, Ctrl+Enter, Cmd+Enter) sent
 *     the message instead. Those chords do NOT insert a break natively in a
 *     `<textarea>` — only Shift+Enter and bare Enter do — so the caller has to
 *     insert it, which is what `insertNewline` below is for.
 *
 * The asymmetry that drives the rules: a wrong "send" DESTROYS text the user
 * typed; a wrong "newline" costs one click on Send. So every modifier is a
 * newline, and anything ambiguous is left to the platform.
 *
 * Pure on purpose — no React, no DOM — so `composerKeys.test.ts` can prove the
 * guard by breaking it.
 */

export type ComposerKeyEvent = {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  /** `KeyboardEvent.isComposing` — on a React synthetic event this lives on `nativeEvent`. */
  isComposing?: boolean;
  /** Legacy IME sentinel; some engines only ever report 229 here. */
  keyCode?: number;
};

/**
 * - `send`    — caller should `preventDefault()` and dispatch.
 * - `newline` — caller must NOT dispatch; the composer ends up with a line
 *               break (natively for Shift+Enter, via `insertNewline` otherwise).
 * - `ignore`  — not our key, or an IME sequence is in flight. Hands off entirely.
 */
export type ComposerKeyDecision = "send" | "newline" | "ignore";

/** True while an input method is mid-composition — Enter commits, never submits. */
export function isComposingKey(event: ComposerKeyEvent): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

export function decideComposerKey(event: ComposerKeyEvent): ComposerKeyDecision {
  if (event.key !== "Enter") return "ignore";
  // IME first: a composing Enter is the user finishing a word, not sending.
  if (isComposingKey(event)) return "ignore";
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return "newline";
  return "send";
}

/**
 * True when the browser will insert the line break for us. Only Shift+Enter
 * (and bare Enter, which we intercept) does that in a `<textarea>`; Alt/Ctrl/
 * Cmd+Enter are inert, so the caller has to do the insertion itself.
 */
export function newlineIsNative(event: ComposerKeyEvent): boolean {
  return event.shiftKey === true;
}

/** Splice a `\n` over `[start, end)` and report where the caret belongs. */
export function insertNewline(
  value: string,
  start: number,
  end: number,
): { value: string; caret: number } {
  const from = Math.max(0, Math.min(Number.isFinite(start) ? start : value.length, value.length));
  const to = Math.max(from, Math.min(Number.isFinite(end) ? end : value.length, value.length));
  return { value: `${value.slice(0, from)}\n${value.slice(to)}`, caret: from + 1 };
}

/**
 * The ONLY normalization a composer value may receive on its way to a runner.
 *
 * Strips surrounding whitespace so an accidental trailing newline doesn't
 * become a "non-empty" prompt, and nothing else. Interior newlines are the
 * user's message structure — a `replace(/\s+/g, " ")` here would silently
 * flatten a numbered list into one line, which is the same defect class as the
 * Enter bug wearing a different hat.
 */
export function normalizeComposerPrompt(value: string): string {
  return value.replace(/^\s+|\s+$/g, "");
}
