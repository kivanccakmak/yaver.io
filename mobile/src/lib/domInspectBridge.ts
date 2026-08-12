// domInspectBridge.ts — the phone's forwarding half of Yaver's DOM MODE
// (element inspect: click any element in the live preview and its HTML, CSS,
// rect and screenshot reach the runner with the next prompt).
//
// ── Why a bus instead of a hook in the preview screen ─────────────────────
//
// Same shape as screenContextBridge.ts: on the phone the preview lives in
// `app/(tabs)/apps.tsx` (and in the `DevPreview` modal), while the composer
// that sends prompts lives in `app/(tabs)/tasks.tsx` — DIFFERENT TABS. A hook
// inside the preview screen would unmount the moment the user switches to
// Tasks to type, which is precisely when the attachment matters. So the
// observed element lives here, above both screens.
//
// ── Why BOTH preview implementations call this ────────────────────────────
//
// `apps.tsx` and `DevPreview.tsx` are the two mobile browser-preview
// implementations, and a fix that lands in one of two implementations is not
// landed (the heartbeat/SSE/shake drift proved it). Both call
// `handlePreviewDomMessage`; domInspect.test.mts scans both sources and fails
// if either goes back to swallowing the message.
//
// ── The security path ────────────────────────────────────────────────────
//
// The probe never talks to the agent. `/dev/` is unauthenticated by design, so
// a direct post would let anyone who can reach :18080 dictate text into
// somebody else's AI prompt. The probe posts to its host surface
// (`window.ReactNativeWebView.postMessage`), and we forward through
// `quicClient` — the phone's existing authenticated client, bearer token,
// relay-or-direct as usual. Never a bare fetch to the dev-server origin, and
// never a widened route on the agent.

import AsyncStorage from "@react-native-async-storage/async-storage";

import { quicClient } from "./quic";
import {
  DOM_INSPECT_PREF_KEY,
  type DomElement,
  type DomItem,
  isDomInspectEnabled,
  parseDomInspectMessage,
  parseDomItemsMessage,
  setDomInspectEnabled,
} from "./domInspect";

/** One selected element, plus the project it belongs to and when we saw it. */
export type ObservedDomElement = {
  el: DomElement;
  /** The preview's project root. The agent keys the element by it; empty
   *  means the preview reported an element we cannot attach to anything,
   *  which the chip states rather than hiding. */
  workDir: string;
  at: number;
};

/** The pickable inventory, as last seen on this phone. */
export type ObservedDomItems = {
  items: DomItem[];
  workDir: string;
  at: number;
};

let observed: ObservedDomElement | null = null;
let observedItems: ObservedDomItems | null = null;

type ElementListener = (el: ObservedDomElement | null) => void;
const elementListeners = new Set<ElementListener>();

type ItemsListener = (items: ObservedDomItems | null) => void;
const itemsListeners = new Set<ItemsListener>();

type ModeListener = (on: boolean) => void;
const modeListeners = new Set<ModeListener>();

function notifyElements() {
  elementListeners.forEach((cb) => {
    try {
      cb(observed);
    } catch {
      /* one bad listener mustn't block the others */
    }
  });
}

function notifyItems() {
  itemsListeners.forEach((cb) => {
    try {
      cb(observedItems);
    } catch {
      /* one bad listener mustn't block the others */
    }
  });
}

function notifyMode(on: boolean) {
  modeListeners.forEach((cb) => {
    try {
      cb(on);
    } catch {
      /* one bad listener mustn't block the others */
    }
  });
}

// Hydrate the mode pref once, at module load, so the synchronous
// `isDomInspectEnabled()` on the mount path is reading the user's real choice
// by the time any preview paints. A failed read leaves the default (off),
// which matches web and matches "off until explicitly enabled".
export const domInspectPrefReady: Promise<void> = (async () => {
  try {
    const raw = await AsyncStorage.getItem(DOM_INSPECT_PREF_KEY);
    if (raw !== null) setDomInspectEnabled(raw === "1");
  } catch {
    /* first run / storage unavailable — default off, same as web */
  }
})();

/**
 * Consume one `onMessage` payload from a preview WebView.
 *
 * `raw` is whatever the WebView handed us — the already-`JSON.parse`d object at
 * both call sites. Returns true when the message was OURS (a clicked element
 * or an items inventory), so the caller can stop looking; false for the
 * preview-probe / render / log messages both lanes already handle, and for
 * anything hostile.
 */
export function handlePreviewDomMessage(raw: unknown, workDir: string | null | undefined): boolean {
  const parsed = parseDomInspectMessage(raw);
  if (parsed) {
    const dir = String(workDir || "").trim();
    observed = { el: parsed, workDir: dir, at: Date.now() };
    notifyElements();
    // The probe auto-offs after a selection (and on Escape) — mirror that here
    // so the chip's Browse|Inspect radio and the probe can never disagree.
    setDomInspectEnabled(false);
    notifyMode(false);
    if (dir) void quicClient.reportDomInspect({ ...parsed, workDir: dir });
    return true;
  }
  const itemsParsed = parseDomItemsMessage(raw);
  if (itemsParsed?.items?.length) {
    const dir = String(workDir || "").trim();
    observedItems = { items: itemsParsed.items, workDir: dir, at: Date.now() };
    notifyItems();
    if (dir) void quicClient.reportDomItems({ workDir: dir, items: itemsParsed.items });
    return true;
  }
  return false;
}

export function getObservedDomElement(): ObservedDomElement | null {
  return observed;
}

export function getObservedDomItems(): ObservedDomItems | null {
  return observedItems;
}

export function subscribeDomInspect(cb: ElementListener): () => void {
  elementListeners.add(cb);
  if (observed) {
    const replay = observed;
    // Defer so the subscriber isn't called inline during its own render.
    setTimeout(() => cb(replay), 0);
  }
  return () => {
    elementListeners.delete(cb);
  };
}

export function subscribeDomItems(cb: ItemsListener): () => void {
  itemsListeners.add(cb);
  if (observedItems) {
    const replay = observedItems;
    setTimeout(() => cb(replay), 0);
  }
  return () => {
    itemsListeners.delete(cb);
  };
}

/**
 * Subscribe to the Inspect-mode flips. The probe lives in the PREVIEW WebView,
 * which is owned by the preview screens (apps.tsx / DevPreview.tsx), not by
 * the chip (Tasks tab). Those screens subscribe here and — on `true` —
 * inject the enable command into the page via their `webViewRef`:
 *
 *   webViewRef.current?.injectJavaScript(
 *     'window.postMessage({source:"yaver-dom",t:"yaver-dom-mode",enabled:true},"*");true;')
 *
 * Injecting into the page delivers to the same window's listeners — the mobile
 * equivalent of the parent→iframe post. The probe auto-offs after a selection,
 * so one selection per toggle is the right mobile UX.
 */
export function subscribeDomInspectMode(cb: ModeListener): () => void {
  modeListeners.add(cb);
  return () => {
    modeListeners.delete(cb);
  };
}

/**
 * The user's mode switch (Browse|Inspect). Persists the choice AND — when
 * turning off — deletes what the agent is already holding, so "off" means the
 * agent is not holding the element rather than holding it and promising not to
 * look. Same semantics as the web chip.
 */
export function setDomModeEnabled(on: boolean, workDir?: string | null): void {
  setDomInspectEnabled(on);
  notifyMode(on);
  void AsyncStorage.setItem(DOM_INSPECT_PREF_KEY, on ? "1" : "0").catch(() => {
    /* the in-memory choice still applies for this session */
  });
  if (!on) {
    const dir = String(workDir || observed?.workDir || "").trim();
    observed = null;
    notifyElements();
    if (dir) void quicClient.clearDomInspect(dir);
  }
}
