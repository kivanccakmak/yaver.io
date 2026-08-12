/**
 * domInspect.ts — the phone half of Yaver's DOM MODE (element inspect,
 * Orca-Design-Mode style: click any element in the live preview and its HTML,
 * computed CSS, rect and a cropped screenshot reach the AI runner with the next
 * prompt).
 *
 * The agent injects a probe into every HTML document it serves for a preview
 * (desktop/agent/dom_inspect_probe.js). The probe cannot talk to the agent
 * directly: the `/dev/` preview route is deliberately unauthenticated, so a
 * page writing straight into the agent would be an unkeyed prompt-injection
 * channel. Instead it `postMessage`s the selected element to whoever embedded
 * it — this app — and we forward it over the session's own authenticated
 * channel.
 *
 * This module is the pure part: validating a message that arrived from a
 * cross-origin frame, clamping it, and describing it to the user. It has no
 * React and no network, so all of it is testable (domInspect.test.mts).
 *
 * TRUST NOTE: everything arriving through `onMessage` is untrusted input. The
 * preview WebView renders a THIRD-PARTY app — the user's own project, but not
 * our code — and any page on the internet can post to any window. So
 * `parseDomInspectMessage` is a validating parser, not a cast: unknown fields
 * are dropped, every string is clamped, `lane` is an allowlist, and the agent
 * re-normalises and re-clamps everything again on receipt
 * (NormalizeDomElement). Two independent clamps because this HTML/CSS/text ends
 * up adjacent to a user's prompt.
 */

/** Mirrors the Go `DomElement` wire shape (desktop/agent/dom_inspect.go). The
 *  probe never sends workDir/capturedAt — the surface adds workDir and the
 *  agent stamps capturedAt — so the parser carries neither. */
export interface DomElement {
  selector?: string;
  tag?: string;
  id?: string;
  classes?: string;
  text?: string;
  html?: string;
  css?: string;
  rect?: string;
  shot?: string;
  lane?: string;
}

/** One visible interactive element from the preview inventory. */
export interface DomItem {
  selector?: string;
  tag?: string;
  id?: string;
  classes?: string;
  text?: string;
  rect?: string;
}

/** One captured inventory for one project. */
export interface DomItems {
  workDir?: string;
  items?: DomItem[];
}

/** Kept in sync with the Go constants; the agent enforces these again. */
export const MAX_DOM_SELECTOR = 200;
export const MAX_DOM_TAG = 40;
export const MAX_DOM_ID = 120;
export const MAX_DOM_CLASSES = 240;
export const MAX_DOM_TEXT = 400;
export const MAX_DOM_HTML = 24000;
export const MAX_DOM_CSS = 16000;
export const MAX_DOM_SHOT = 16000; // base64 JPEG dataURL
export const MAX_DOM_RECT = 120;
export const MAX_DOM_ITEMS = 40;

export const DOM_INSPECT_SOURCE = "yaver-dom";
export const DOM_INSPECT_MESSAGE = "yaver-dom-element";
export const DOM_ITEMS_MESSAGE = "yaver-dom-items-list";
export const DOM_MODE_COMMAND = "yaver-dom-mode";
export const DOM_ITEMS_COMMAND = "yaver-dom-items";

/** Storage key for whether DOM mode was left on. Default OFF — DOM mode is
 *  opt-in by design ("off until explicitly enabled"), unlike screen context
 *  which is ambient. */
export const DOM_INSPECT_PREF_KEY = "yaver.domInspect.enabled";

/**
 * Clamp to `max` CODE POINTS, appending an ellipsis when it cut.
 *
 * Code-point-wise rather than UTF-16-unit-wise: `"😀".repeat(60).slice(0, 79)`
 * ends on the HIGH half of a surrogate pair, and that lone surrogate becomes
 * U+FFFD "�" the moment the report is JSON-encoded and sent as UTF-8. The Go
 * side goes to exactly this trouble (dom_inspect.go::truncateRunes) because
 * this text is routinely Turkish, Japanese or emoji.
 */
function clamp(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const runes = Array.from(flat);
  if (runes.length <= max) return flat;
  if (max <= 1) return runes.slice(0, max).join("");
  return `${runes.slice(0, max - 1).join("")}…`;
}

/**
 * Validate + clamp a raw `postMessage` payload carrying a clicked element.
 *
 * Returns `null` for anything that is not a DOM-element message, which is the
 * overwhelmingly common case: the app's own preview-probe, render and log
 * messages, React DevTools, browser extensions and the OAuth popup all post
 * into this window. A parser that threw, or that trusted `data.el`, would turn
 * any of those into a crash or an injection.
 */
export function parseDomInspectMessage(data: unknown): DomElement | null {
  if (!data || typeof data !== "object") return null;
  const msg = data as Record<string, unknown>;
  if (msg.source !== DOM_INSPECT_SOURCE) return null;
  if (msg.t !== DOM_INSPECT_MESSAGE) return null;
  const raw = msg.el;
  if (!raw || typeof raw !== "object") return null;
  const el = raw as Record<string, unknown>;

  // `lane` is an allowlist rather than a clamp — it is the one field that could
  // otherwise carry free prose into a block that sits next to a prompt.
  const laneRaw = typeof el.lane === "string" ? el.lane : "";
  const lane = laneRaw === "browser" || laneRaw === "webview" || laneRaw === "native" ? laneRaw : "";

  // The shot follows Go's rule: oversized is DROPPED, never truncated — a cut
  // dataURL is a broken image, which is worse than no image.
  const shotRaw = typeof el.shot === "string" ? el.shot : "";
  const shot = shotRaw.length > MAX_DOM_SHOT ? "" : shotRaw;

  const out: DomElement = {
    selector: clamp(el.selector, MAX_DOM_SELECTOR),
    tag: clamp(el.tag, MAX_DOM_TAG),
    id: clamp(el.id, MAX_DOM_ID),
    classes: clamp(el.classes, MAX_DOM_CLASSES),
    text: clamp(el.text, MAX_DOM_TEXT),
    html: clamp(el.html, MAX_DOM_HTML),
    css: clamp(el.css, MAX_DOM_CSS),
    rect: clamp(el.rect, MAX_DOM_RECT),
    shot,
    lane,
  };
  if (isEmptyDomElement(out)) return null;
  return out;
}

/**
 * Validate + clamp a raw `postMessage` payload carrying the interactive-items
 * inventory (the probe's answer to a `yaver-dom-items` request).
 */
export function parseDomItemsMessage(data: unknown): DomItems | null {
  if (!data || typeof data !== "object") return null;
  const msg = data as Record<string, unknown>;
  if (msg.source !== DOM_INSPECT_SOURCE) return null;
  if (msg.t !== DOM_ITEMS_MESSAGE) return null;
  if (!Array.isArray(msg.items)) return null;

  const items: DomItem[] = [];
  const seen = new Set<string>();
  for (const entry of msg.items) {
    if (!entry || typeof entry !== "object") continue;
    const it = entry as Record<string, unknown>;
    const item: DomItem = {
      selector: clamp(it.selector, MAX_DOM_SELECTOR),
      tag: clamp(it.tag, MAX_DOM_TAG),
      id: clamp(it.id, MAX_DOM_ID),
      classes: clamp(it.classes, MAX_DOM_CLASSES),
      text: clamp(it.text, MAX_DOM_TEXT),
      rect: clamp(it.rect, MAX_DOM_RECT),
    };
    if (!item.selector && !item.tag) continue;
    // Dedupe by selector+tag, mirroring NormalizeDomItems.
    const key = `${item.selector}\u0000${item.tag}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= MAX_DOM_ITEMS) break;
  }
  if (items.length === 0) return null;
  return { items };
}

export function isEmptyDomElement(el: DomElement | null | undefined): boolean {
  if (!el) return true;
  return !el.selector && !el.tag && !el.text && !el.html;
}

/**
 * The chip label. Names the element the way the runner will see it — a chip
 * that said "element attached" without saying WHICH element would be the
 * silent-mutation defect this feature is supposed to remove.
 */
export function domInspectSummary(el: DomElement | null | undefined): string {
  if (isEmptyDomElement(el) || !el) return "";
  const name = el.selector || el.tag || el.id || "";
  if (!name) return "";
  return el.text ? `${name} — ${clamp(el.text, 48)}` : name;
}

/** The expanded detail shown on expand — exactly the facts we forward. */
export function domInspectDetail(el: DomElement | null | undefined): string[] {
  if (isEmptyDomElement(el) || !el) return [];
  const lines: string[] = [];
  if (el.selector) lines.push(`selector: ${el.selector}`);
  if (el.tag) lines.push(`tag: ${el.tag}`);
  if (el.rect) lines.push(`rect: ${el.rect}`);
  if (el.id) lines.push(`id: ${el.id}`);
  if (el.classes) lines.push(`classes: ${el.classes}`);
  if (el.text) lines.push(`text: ${el.text}`);
  if (el.html) lines.push(`html: ${el.html.length.toLocaleString()} chars`);
  if (el.css) lines.push(`css: ${el.css.length.toLocaleString()} chars`);
  if (el.shot) lines.push("screenshot: attached");
  return lines;
}

/** The command that flips the probe into (or out of) inspect mode. */
export function domInspectModeCommand(enabled: boolean): { source: string; t: string; enabled: boolean } {
  return { source: DOM_INSPECT_SOURCE, t: DOM_MODE_COMMAND, enabled };
}

/** The command that asks the probe for a bounded inventory of interactive items. */
export function domItemsCommand(max?: number): { source: string; t: string; max: number } {
  // `??` not `||`: a caller asking for 0 items must not be coerced to the
  // default — the probe clamps max into [1, 40] either way, but the intent
  // should survive the command.
  const n = Math.max(1, Math.min(Math.trunc(max ?? MAX_DOM_ITEMS), MAX_DOM_ITEMS));
  return { source: DOM_INSPECT_SOURCE, t: DOM_ITEMS_COMMAND, max: n };
}

// ── PLATFORM STORAGE ──────────────────────────────────────────────────────
//
// Everything ABOVE this line is pure and is byte-identical to the web twin
// (web/lib/domInspect.ts) — pinned by the parity test in domInspect.test.mts.
// Everything BELOW is where the two surfaces legitimately differ: the browser
// has a synchronous localStorage, React Native does not. Same exported names,
// same defaults, same meaning of "off" — different store.

// The pref is held in memory here and PERSISTED BY domInspectBridge.ts.
//
// It is split that way for one concrete reason: React Native's only storage is
// asynchronous (AsyncStorage), and `isDomInspectEnabled()` is called on the hot
// path — when the preview mounts and needs to know whether to post the
// enable-command — where an await would race the read. A synchronous read of a
// hydrated cache cannot do that.
//
// It also keeps this file import-free, which is what lets the whole parser run
// under `node --test` with no React Native runtime. Importing AsyncStorage here
// would make the parser — the part that meets hostile input — untestable, and
// an untested validating parser is just a cast with a comment.
//
// The consequence to know about: calling `setDomInspectEnabled` DIRECTLY
// changes this session only. UI must go through `domInspectBridge.setDomModeEnabled`,
// which writes the store AND deletes what the agent is already holding.
let domInspectEnabled = false;

/** Read whether DOM mode was left on. Default OFF — opt-in, never default.
 *  Synchronous by design — see above. */
export function isDomInspectEnabled(): boolean {
  return domInspectEnabled;
}

export function setDomInspectEnabled(on: boolean): void {
  domInspectEnabled = on;
}
