/**
 * screenContext.ts — the PHONE half of "the agent knows which screen you're
 * looking at". Twin of web/lib/screenContext.ts.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * The agent injects one probe into every HTML document it serves for a preview
 * (desktop/agent/screen_context_probe.js), and that probe has ALWAYS had an
 * explicit React Native branch:
 *
 *     lane: window.ReactNativeWebView ? "webview" : "browser"
 *     if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage)
 *
 * Code written for exactly one consumer — this phone. Until this file landed,
 * that consumer did not exist: the message arrived at both mobile WebView
 * previews and fell into a bare `catch {}`. The phone paid for the probe (the
 * bytes, the poll, the postMessage) and got nothing, while the web dashboard
 * got the feature. That is the "inventory says yes / operation says no" shape
 * this repo keeps finding, wearing a cross-surface hat.
 *
 * ── The security path, which is NOT negotiable ────────────────────────────
 *
 * The probe cannot talk to the agent directly: `/dev/` is deliberately
 * unauthenticated, so a page writing straight into the agent would be an
 * unkeyed prompt-injection channel — anyone who can reach :18080 could dictate
 * text into somebody else's AI prompt. So the probe posts to its HOST SURFACE
 * and the surface forwards over its own authenticated channel. On the phone
 * that means `quicClient` (bearer token, relay/direct as usual) — never a bare
 * fetch to the dev-server origin. See screenContextBridge.ts.
 *
 * This module is the pure part: validating a message that arrived from a
 * WebView running a third-party app, clamping it, and describing it to the
 * user. No React, no React Native, no network — so all of it runs under
 * `node --experimental-strip-types --test` (screenContext.test.mts).
 *
 * TRUST NOTE: everything arriving through the WebView's `onMessage` is
 * untrusted input. The preview renders a THIRD-PARTY app — the user's own
 * project, but not our code — and any script in that page can post any string
 * it likes. So `parseScreenContextMessage` is a validating parser, not a cast:
 * unknown fields are dropped, every string is clamped, and the agent
 * re-normalises and re-clamps everything again on receipt
 * (NormalizeScreenContext). Two independent clamps because this text ends up
 * adjacent to a user's prompt.
 */

/** Mirrors the Go `ScreenContext` wire shape (desktop/agent/screen_context.go). */
export interface ScreenContext {
  workDir?: string;
  route?: string;
  title?: string;
  heading?: string;
  controls?: string[];
  component?: string;
  lane?: string;
}

/** Kept in sync with the Go constants; the agent enforces these again. */
export const MAX_SCREEN_CONTROLS = 25;
export const MAX_SCREEN_LABEL = 80;
export const MAX_SCREEN_TITLE = 120;
export const MAX_SCREEN_ROUTE = 200;

export const SCREEN_CONTEXT_MESSAGE = "yaver-screen-context";
export const SCREEN_CONTEXT_SOURCE = "yaver-screen";

/** Storage key for the user's opt-out. Per-device, not per-project: the
 *  setting is a privacy preference about this machine's screen, not a project
 *  attribute. */
export const SCREEN_CONTEXT_PREF_KEY = "yaver.screenContext.enabled";

/**
 * Clamp to `max` CODE POINTS, appending an ellipsis when it cut.
 *
 * Code-point-wise rather than UTF-16-unit-wise, and the distinction is not
 * academic: `"😀".repeat(60).slice(0, 79)` ends on the HIGH half of a surrogate
 * pair, and that lone surrogate becomes U+FFFD "�" the moment the report is
 * JSON-encoded and sent as UTF-8 — a visible mojibake in the one string a human
 * reads for meaning, one hop from their prompt. The Go side goes to exactly
 * this trouble (screen_context.go::truncateRunes) precisely because this text
 * is routinely Turkish, Japanese or emoji; the browser/phone halves silently
 * did not until 2026-07-27.
 *
 * Matches Go's rune semantics, including its limit: a ZWJ sequence or a flag
 * (two regional indicators) can still be split BETWEEN code points, same as
 * `[]rune` does. Aligning the two implementations is the property worth having.
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
 * Validate + clamp a raw `postMessage` payload.
 *
 * Returns `null` for anything that is not a screen-context message, which is
 * the overwhelmingly common case: the dashboard's own sandbox bridges, React
 * DevTools, browser extensions and the OAuth popup all post into this window.
 * A parser that threw, or that trusted `data.ctx`, would turn any of those into
 * a crash or an injection.
 */
export function parseScreenContextMessage(data: unknown): ScreenContext | null {
  if (!data || typeof data !== "object") return null;
  const msg = data as Record<string, unknown>;
  if (msg.source !== SCREEN_CONTEXT_SOURCE) return null;
  if (msg.t !== SCREEN_CONTEXT_MESSAGE) return null;
  const raw = msg.ctx;
  if (!raw || typeof raw !== "object") return null;
  const ctx = raw as Record<string, unknown>;

  const controls: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(ctx.controls)) {
    for (const entry of ctx.controls) {
      const label = clamp(entry, MAX_SCREEN_LABEL);
      if (!label) continue;
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      controls.push(label);
      if (controls.length >= MAX_SCREEN_CONTROLS) break;
    }
  }

  // `lane` is an allowlist rather than a clamp — it is the one field that could
  // otherwise carry free prose into a block that sits next to a prompt.
  const laneRaw = typeof ctx.lane === "string" ? ctx.lane : "";
  const lane = laneRaw === "browser" || laneRaw === "webview" || laneRaw === "native" ? laneRaw : "";

  const out: ScreenContext = {
    route: clamp(ctx.route, MAX_SCREEN_ROUTE),
    title: clamp(ctx.title, MAX_SCREEN_TITLE),
    heading: clamp(ctx.heading, MAX_SCREEN_TITLE),
    component: clamp(ctx.component, MAX_SCREEN_LABEL),
    controls,
    lane,
  };
  if (isEmptyScreenContext(out)) return null;
  return out;
}

export function isEmptyScreenContext(ctx: ScreenContext | null | undefined): boolean {
  if (!ctx) return true;
  return !ctx.route && !ctx.title && !ctx.heading && !ctx.component && !(ctx.controls && ctx.controls.length);
}

/**
 * The chip label. This is the user's ONLY window into what got attached, so it
 * names the screen the way the runner will see it — a chip that said "context
 * attached" without saying WHICH context would be the silent-mutation defect
 * this feature is supposed to remove.
 */
export function screenContextSummary(ctx: ScreenContext | null | undefined): string {
  if (isEmptyScreenContext(ctx) || !ctx) return "";
  const name = ctx.heading || ctx.title || ctx.route || "";
  if (!name) return "";
  const n = ctx.controls?.length || 0;
  return n > 0 ? `${name} (${n} control${n === 1 ? "" : "s"})` : name;
}

/** The expanded detail shown on hover/expand — exactly the facts we forward. */
export function screenContextDetail(ctx: ScreenContext | null | undefined): string[] {
  if (isEmptyScreenContext(ctx) || !ctx) return [];
  const lines: string[] = [];
  if (ctx.route) lines.push(`route: ${ctx.route}`);
  if (ctx.heading) lines.push(`heading: ${ctx.heading}`);
  if (ctx.title && ctx.title.toLowerCase() !== (ctx.heading || "").toLowerCase()) lines.push(`title: ${ctx.title}`);
  if (ctx.component) lines.push(`component: ${ctx.component}`);
  if (ctx.controls?.length) lines.push(`visible controls: ${ctx.controls.join(" · ")}`);
  return lines;
}

/**
 * True when two observations describe the same screen, so the bridge can skip a
 * redundant POST. Compared on CONTENT, not on identity — the probe re-sends on
 * a heartbeat precisely so the agent's freshness window does not lapse, and the
 * heartbeat is handled by the caller's timer rather than by pretending the
 * screen changed.
 */
export function sameScreenContext(a: ScreenContext | null, b: ScreenContext | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.route === b.route &&
    a.title === b.title &&
    a.heading === b.heading &&
    a.component === b.component &&
    (a.controls || []).join("\u0000") === (b.controls || []).join("\u0000")
  );
}

// ── PLATFORM STORAGE ──────────────────────────────────────────────────────
//
// Everything ABOVE this line is pure and is byte-identical to the web twin
// (web/lib/screenContext.ts) — pinned by the parity test in screenContext.test.mts.
// Everything BELOW is where the two surfaces legitimately differ: the browser
// has a synchronous localStorage, React Native does not. Same exported names,
// same defaults, same meaning of "off" — different store.

// The pref is held in memory here and PERSISTED BY screenContextBridge.ts.
//
// It is split that way for one concrete reason: React Native's only storage is
// asynchronous (AsyncStorage), and `isScreenContextEnabled()` is called on the
// hot path — once per probe post, inside a WebView message handler — where an
// await would mean the first observations of every preview race the read and
// get forwarded under a default the user may have turned off. A synchronous
// read of a hydrated cache cannot do that.
//
// It also keeps this file import-free, which is what lets the whole parser run
// under `node --test` with no React Native runtime. Importing AsyncStorage here
// would make the parser — the part that meets hostile input — untestable, and
// an untested validating parser is just a cast with a comment.
//
// The consequence to know about: calling `setScreenContextEnabled` DIRECTLY
// changes this session only. UI must go through `screenContextBridge.setEnabled`,
// which writes the store AND deletes what the agent is already holding.
let screenContextEnabled = true;

/** Read the opt-out. Default ON. Synchronous by design — see above. */
export function isScreenContextEnabled(): boolean {
  return screenContextEnabled;
}

export function setScreenContextEnabled(on: boolean): void {
  screenContextEnabled = on;
}
