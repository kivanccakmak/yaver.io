export type ReloadIntent = {
  projectName?: string;
};

// Keep this deliberately narrow. A whole-message command may name one
// path-safe project token ("reload sfmg"); sentences such as "reload the user
// list after delete" remain ordinary coding prompts.
const RELOAD_INTENT =
  /^\s*(?:please\s+)?(?:fast\s+)?(?:hot\s*reload|reload|re-?render|refresh|hermes(?:\s+reload)?|rebuild(?:\s+bundle)?|push\s+bundle)(?:\s+(?:it|again|the\s+(?:app|preview|ui)|([a-z0-9._-]{1,40})))?\s*[.!?]?\s*$/i;

export function parseReloadIntent(text: string): ReloadIntent | null {
  const match = RELOAD_INTENT.exec(text.trim());
  if (!match) return null;
  return match[1] ? { projectName: match[1] } : {};
}

export function isReloadIntent(text: string): boolean {
  return parseReloadIntent(text) !== null;
}
