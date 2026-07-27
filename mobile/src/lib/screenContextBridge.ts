// screenContextBridge.ts — the phone's forwarding half of "the agent knows
// which screen you're looking at".
//
// ── Why a bus instead of a hook in the preview screen ─────────────────────
//
// On web this is one component: RuntimeLabView owns the preview iframe AND the
// composer, so the chip can listen and forward in one place. On the phone they
// are DIFFERENT TABS — the preview lives in `app/(tabs)/apps.tsx` (and in the
// `DevPreview` modal), the composer that sends prompts lives in
// `app/(tabs)/tasks.tsx`. A hook inside the preview screen would unmount the
// moment the user switches to Tasks to type, which is precisely when the
// attachment matters. So the observation lives here, above both screens, in the
// same shape as openAppBus.ts.
//
// ── Why BOTH preview implementations call this ────────────────────────────
//
// `apps.tsx` and `DevPreview.tsx` are the two mobile browser-preview
// implementations, and a fix that lands in one of two implementations is not
// landed — that exact drift already shipped a broken heartbeat, dropped SSE
// frames and a dead shake gesture in this repo. Both call
// `handlePreviewScreenMessage`; screenContext.test.mts scans both sources and
// fails if either goes back to swallowing the message.
//
// ── The security path ────────────────────────────────────────────────────
//
// The probe never talks to the agent. `/dev/` is unauthenticated by design, so a
// direct post would let anyone who can reach :18080 dictate text into somebody
// else's AI prompt. The probe posts to its host surface
// (`window.ReactNativeWebView.postMessage`), and we forward through
// `quicClient` — the phone's existing authenticated client, bearer token,
// relay-or-direct as usual. Never a bare fetch to the dev-server origin, and
// never a widened route on the agent.

import AsyncStorage from "@react-native-async-storage/async-storage";

import { quicClient } from "./quic";
import {
  SCREEN_CONTEXT_PREF_KEY,
  type ScreenContext,
  isScreenContextEnabled,
  parseScreenContextMessage,
  sameScreenContext,
  setScreenContextEnabled,
} from "./screenContext";

/** One observation, plus the project it belongs to and when we saw it. */
export type ObservedScreen = {
  ctx: ScreenContext;
  /** The preview's project root. The agent keys screen context by it; empty
   *  means the preview reported a screen we cannot attach to anything, which
   *  the chip states rather than hiding. */
  workDir: string;
  at: number;
};

/** Re-post an unchanged screen this often so the agent's freshness window
 *  (screenContextTTL, 3 min) cannot lapse while the user sits in the Tasks tab
 *  composing a prompt. Comfortably inside it, and matched to the web chip. */
const HEARTBEAT_MS = 60_000;

let observed: ObservedScreen | null = null;
let lastSent: ScreenContext | null = null;
let lastSentAt = 0;
let lastSentWorkDir = "";

type Listener = (screen: ObservedScreen | null) => void;
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach((cb) => {
    try {
      cb(observed);
    } catch {
      // One bad listener mustn't block the others.
    }
  });
}

// Hydrate the opt-out once, at module load, so the synchronous
// `isScreenContextEnabled()` on the forward path is reading the user's real
// choice by the time any preview paints. A failed read leaves the default (on),
// which matches web.
export const screenContextPrefReady: Promise<void> = (async () => {
  try {
    const raw = await AsyncStorage.getItem(SCREEN_CONTEXT_PREF_KEY);
    if (raw !== null) setScreenContextEnabled(raw !== "0");
  } catch {
    /* first run / storage unavailable — default on, same as web */
  }
})();

function forward(ctx: ScreenContext, workDir: string) {
  const now = Date.now();
  if (
    workDir === lastSentWorkDir &&
    sameScreenContext(ctx, lastSent) &&
    now - lastSentAt < HEARTBEAT_MS
  ) {
    return;
  }
  lastSent = ctx;
  lastSentAt = now;
  lastSentWorkDir = workDir;
  // Advisory work must never sit in the critical path of the operation it
  // annotates: a failed screen report must not surface as a toast, must not
  // retry, and must not block the preview. The agent re-clamps and re-stamps
  // everything anyway.
  void quicClient.reportScreenContext({ ...ctx, workDir });
}

/**
 * Consume one `onMessage` payload from a preview WebView.
 *
 * `raw` is whatever the WebView handed us — the already-`JSON.parse`d object at
 * both call sites. Returns true when the message was OURS, so the caller can
 * stop looking; false for the preview-probe / render / log messages both lanes
 * already handle, and for anything hostile.
 */
export function handlePreviewScreenMessage(raw: unknown, workDir: string | null | undefined): boolean {
  const parsed = parseScreenContextMessage(raw);
  if (!parsed) return false;
  const dir = String(workDir || "").trim();
  observed = { ctx: parsed, workDir: dir, at: Date.now() };
  notify();
  // No workDir means there is nothing to key the observation to on the agent
  // side (POST /screen-context answers 400 by design). We still record it so
  // the chip can SAY that, instead of showing a chip that silently attaches
  // nothing.
  if (dir && isScreenContextEnabled()) forward(parsed, dir);
  return true;
}

export function getObservedScreen(): ObservedScreen | null {
  return observed;
}

export function subscribeScreenContext(cb: Listener): () => void {
  listeners.add(cb);
  if (observed) {
    const replay = observed;
    // Defer so the subscriber isn't called inline during its own render.
    setTimeout(() => cb(replay), 0);
  }
  return () => {
    listeners.delete(cb);
  };
}

/**
 * The user's switch. Persists the choice AND — when turning off — deletes what
 * the agent is already holding, so "off" means the agent is not holding your
 * screen rather than holding it and promising not to look. Same semantics as
 * the web chip.
 */
export function setEnabled(on: boolean): void {
  setScreenContextEnabled(on);
  void AsyncStorage.setItem(SCREEN_CONTEXT_PREF_KEY, on ? "1" : "0").catch(() => {
    /* the in-memory choice still applies for this session */
  });
  if (!on) {
    const dir = lastSentWorkDir || observed?.workDir || "";
    lastSent = null;
    lastSentAt = 0;
    lastSentWorkDir = "";
    if (dir) void quicClient.clearScreenContext(dir);
    return;
  }
  // Turning it back on re-reports immediately: a chip that says "on" while the
  // agent holds nothing until the probe's next 45s heartbeat is the same lie in
  // the other direction.
  if (observed?.workDir) forward(observed.ctx, observed.workDir);
}

// NOT here on purpose: a "forget on preview close" call. The agent already
// expires an observation after screenContextTTL (3 minutes) and refuses to
// serve a stale one, and the probe re-posts on a 45s heartbeat only while the
// preview is actually open — so a closed preview stops refreshing and ages out
// by itself. A second, client-driven expiry path would be a second place for
// the two to disagree about what the agent is holding. The user's explicit
// "off" (setEnabled(false)) deletes immediately; everything else is the TTL's
// job.
