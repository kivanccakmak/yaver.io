export function autoRenderVibingFromSettings(settings: unknown): boolean {
  return !!settings && typeof settings === "object" && (settings as { autoRenderVibing?: unknown }).autoRenderVibing === true;
}

/** A chat message is an execution command only when the whole message is a
 * short render instruction. Mentions such as "fix the reload bug" stay coding
 * prompts and can never refresh a surface by accident. */
export function isExplicitRenderPrompt(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ");
  return /^(please )?(fast )?(re-?render|reload|refresh)( (it|again|the (app|preview|ui)))?$/.test(normalized);
}
