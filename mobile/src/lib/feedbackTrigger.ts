import AsyncStorage from "@react-native-async-storage/async-storage";
import { Accelerometer } from "expo-sensors";
import { AppState, type AppStateStatus, NativeEventEmitter, NativeModules, Platform } from "react-native";
import { quicClient, type RemoteRuntimeSession } from "./quic";
import { appLog } from "./logger";
import { planPostTaskRender, type PostTaskRenderDecision } from "./previewReload";

type FeedbackLaunchSource = "shake" | "native-guest-shake" | "remote-runtime";

type FeedbackLaunchListener = (payload: { source: FeedbackLaunchSource }) => void;

const listeners = new Set<FeedbackLaunchListener>();
const FEEDBACK_KEY_FALLBACK = "@yaver/feedback_config";
let activeRemoteRuntimeSessionID: string | null = null;
let activeRemoteRuntimeSession: Pick<RemoteRuntimeSession, "id" | "workDir" | "targetId" | "targetLabel"> | null = null;
let cooldownUntil = 0;
let remoteRuntimeRenderInFlight = false;

// The active preview lane. Set by DevPreview (browser) / remote-runtime (webrtc)
// so a shake routes to the RIGHT place. In the Hermes lane the native container
// owns the shake; in the browser lane the app lives in a WebView INSIDE Yaver,
// so a shake must be forwarded INTO that WebView to open the guest's own web /
// Flutter feedback SDK — the container overlay would be the wrong thing.
type PreviewLane = "browser" | "webrtc" | null;
let activePreviewLane: PreviewLane = null;
const browserShakeListeners = new Set<() => void>();

export function setActivePreviewLane(lane: PreviewLane): void {
  activePreviewLane = lane;
}

export function getActivePreviewLane(): PreviewLane {
  return activePreviewLane;
}

/**
 * Browser-lane render listeners. Mirrors subscribeBrowserShake: the preview
 * surface (DevPreview / apps.tsx) owns the WebView, so it performs the actual
 * refresh; this module only decides that one is due.
 *
 * Before 2026-08-02 there was no such registry, which is why a browser-lane
 * preview never refreshed when a coding turn landed — the whole point of
 * Attach Mode.
 */
const browserRenderListeners = new Set<(source: string) => void>();

export function subscribeBrowserRender(cb: (source: string) => void): () => void {
  browserRenderListeners.add(cb);
  return () => browserRenderListeners.delete(cb);
}

/**
 * DevPreview subscribes here; when a shake happens while a browser-lane preview
 * is open, it injects a feedback-launch into the WebView.
 */
export function subscribeBrowserShake(cb: () => void): () => void {
  browserShakeListeners.add(cb);
  return () => browserShakeListeners.delete(cb);
}

function nowMs() {
  return Date.now();
}

export function subscribeFeedbackLaunch(listener: FeedbackLaunchListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function triggerFeedbackLaunch(source: FeedbackLaunchSource): void {
  for (const listener of listeners) listener({ source });
}

export function setActiveRemoteRuntimeSession(session: RemoteRuntimeSession | string | null): void {
  if (!session) {
    activeRemoteRuntimeSessionID = null;
    activeRemoteRuntimeSession = null;
    return;
  }
  if (typeof session === "string") {
    activeRemoteRuntimeSessionID = session;
    activeRemoteRuntimeSession = { id: session, workDir: "", targetId: "", targetLabel: "" };
    return;
  }
  activeRemoteRuntimeSessionID = session.id;
  activeRemoteRuntimeSession = {
    id: session.id,
    workDir: session.workDir || "",
    targetId: session.targetId || "",
    targetLabel: session.targetLabel || session.targetId || "",
  };
}

export function getActiveRemoteRuntimeSession(): Pick<RemoteRuntimeSession, "id" | "workDir" | "targetId" | "targetLabel"> | null {
  return activeRemoteRuntimeSession;
}

function canRunGuestOnRemoteTarget(targetId?: string): boolean {
  return [
    "ios-simulator",
    "ipados-simulator",
    "watchos-simulator",
    "tvos-simulator",
    "visionos-simulator",
    "android-emulator",
    "android-wear",
    "android-tv",
    "android-xr",
    "android-auto",
    "android-redroid",
  ].includes(String(targetId || ""));
}

/**
 * Refresh whichever preview surface is actually open when a coding turn lands.
 *
 * This is the entry point Tasks should call. It used to be
 * rerenderActiveRemoteRuntimeSurface() directly, which meant the browser lane
 * never refreshed and the Yaver-on-Yaver case (WebRTC on a browser target)
 * returned a bare `false` — task done, nothing rendered, nothing said.
 *
 * The decision is planPostTaskRender() in previewReload.ts (pure + tested);
 * this function only performs the effect and reports the sentence.
 */
export async function rerenderActivePreviewSurface(opts: {
  source?: string;
  workDir?: string;
  taskStatus?: string | null;
}): Promise<PostTaskRenderDecision> {
  const source = opts.source || "mobile-auto-render";
  const session = activeRemoteRuntimeSession;
  const decision = planPostTaskRender({
    lane: activePreviewLane,
    taskStatus: opts.taskStatus,
    hasWebrtcSession: !!session?.id,
    webrtcTargetCanRender: !session?.targetId || canRunGuestOnRemoteTarget(session.targetId),
    webrtcTargetLabel: session?.targetLabel || session?.targetId,
    inFlight: remoteRuntimeRenderInFlight,
  });

  if (decision.action === "skip") {
    // Never silent. The old code's bare `return false` is exactly what made
    // this unfalsifiable from the user's side.
    appLog("info", `post-task render skipped (${decision.reason}) for ${source}: ${decision.message}`);
    return decision;
  }

  if (decision.lane === "browser") {
    appLog("info", `post-task render: refreshing browser-lane preview for ${source}`);
    for (const cb of browserRenderListeners) {
      try {
        cb(source);
      } catch {
        // one bad listener mustn't block the others
      }
    }
    return decision;
  }

  await rerenderActiveRemoteRuntimeSurface(source, opts.workDir);
  return decision;
}

export async function rerenderActiveRemoteRuntimeSurface(source = "mobile-auto-render", workDir?: string): Promise<boolean> {
  const session = activeRemoteRuntimeSession;
  if (!session?.id) {
    appLog("info", `remote runtime render skipped: no active session (${source})`);
    return false;
  }
  if (session.targetId && !canRunGuestOnRemoteTarget(session.targetId)) {
    appLog(
      "info",
      `remote runtime render skipped: target ${session.targetId} cannot re-render in place (${source})`,
    );
    return false;
  }
  if (remoteRuntimeRenderInFlight) {
    appLog("info", `remote runtime render already in flight; skipped ${source}`);
    return false;
  }
  const effectiveWorkDir = workDir || session.workDir || undefined;
  remoteRuntimeRenderInFlight = true;
  try {
    const result = await quicClient.sendRemoteRuntimeCommand(session.id, "run-guest", source, effectiveWorkDir);
    if (result.session) setActiveRemoteRuntimeSession(result.session);
    appLog("info", `remote runtime auto-render requested for ${session.targetLabel || session.targetId || session.id}`);
    return true;
  } catch (err) {
    appLog("warn", `remote runtime auto-render failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    remoteRuntimeRenderInFlight = false;
  }
}

async function currentFeedbackConfig(userId?: string | null): Promise<{ enabled?: boolean; trigger?: string } | null> {
  const keys = userId ? [`@yaver/u/${userId}/feedback_config`, FEEDBACK_KEY_FALLBACK] : [FEEDBACK_KEY_FALLBACK];
  for (const key of keys) {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (raw) return JSON.parse(raw);
    } catch {
      // ignore
    }
  }
  return null;
}

async function maybeLaunchFeedbackFromShake(source: FeedbackLaunchSource, userId?: string | null): Promise<void> {
  if (nowMs() < cooldownUntil) return;
  // `native-guest-shake` and `remote-runtime` are unconditional: the user
  // explicitly entered guest-runtime mode (Hermes-pushed bundle inside the
  // Yaver host, or a remote-runtime session bridging an external app), so
  // a shake there IS the opt-in signal. Don't gate it on the user's
  // settings.feedback.enabled toggle — that toggle is for the standalone
  // Yaver app's own draggable mic/icon. If we honored it here, every
  // first-time guest-app shake would silently no-op and the user would
  // think the SDK is broken.
  //
  // For non-guest sources (a shake while standing on Yaver's own surfaces
  // with no guest active) we keep the toggle gate so the floating button
  // stays opt-in.
  // A shake while ANY preview lane is active (browser WebView or webrtc stream)
  // is the opt-in signal — the user is looking at their app inside Yaver and
  // shook to report on it. Don't gate those on the standalone-app toggle, same
  // reasoning as native-guest-shake / remote-runtime.
  const isImplicitOptIn =
    source === "native-guest-shake" || source === "remote-runtime" || activePreviewLane !== null;
  if (!isImplicitOptIn) {
    const cfg = await currentFeedbackConfig(userId);
    if (!cfg?.enabled || cfg.trigger !== "shake") return;
  }
  cooldownUntil = nowMs() + 2500;

  // BROWSER LANE: the app runs in a WebView inside Yaver. Forward the shake INTO
  // the WebView (a guest web app that embeds yaver-feedback-web opens its own
  // overlay) AND fall through to Yaver's own container overlay below — because a
  // flutter-web app can't run the Flutter SDK (dart:io) on web, so the container
  // overlay (which captures the visible WebView) is the reliable, universal
  // path. Either way a shake now opens feedback, matching the Hermes lane.
  if (activePreviewLane === "browser") {
    for (const cb of browserShakeListeners) { try { cb(); } catch { /* one bad listener mustn't block others */ } }
  }
  // quicClient.isConnected checks the FOCUSED pool client only. The
  // remote-runtime session might be bound to a different (still
  // pooled) device — in that case the focused check would fail and
  // the launch-feedback command would silently never go out. We can't
  // know from here which pool client owns the session, so be lenient:
  // try to send through the focused client AND let the call fail
  // softly (.catch), since the worst case is a no-op the user can
  // re-trigger by shaking again.
  if (activeRemoteRuntimeSessionID) {
    quicClient.sendRemoteRuntimeCommand(activeRemoteRuntimeSessionID, "launch-feedback", source).catch(() => {});
  }
  triggerFeedbackLaunch(source);
}

export function startFeedbackShakeBridge(userId?: string | null): () => void {
  // Web has no accelerometer native module — shake-to-feedback is a no-op there
  // (the browser preview is dev-only). Guard avoids a boot crash:
  // "this._nativeModule.addListener is not a function".
  if (Platform.OS === "web") {
    return () => {};
  }
  let lastMagnitude = 0;
  let appState: AppStateStatus = AppState.currentState;
  const appStateSub = AppState.addEventListener("change", async (nextState) => {
    appState = nextState;
    if (nextState === "active") {
      try {
        const pending = await (NativeModules as any)?.YaverInfo?.consumePendingFeedbackLaunch?.();
        if (pending) {
          await maybeLaunchFeedbackFromShake("native-guest-shake", userId);
        }
      } catch {
        // ignore
      }
    }
  });

  Accelerometer.setUpdateInterval(220);
  const accelSub = Accelerometer.addListener(({ x, y, z }) => {
    if (appState !== "active") return;
    const magnitude = Math.sqrt(x * x + y * y + z * z);
    const delta = Math.abs(magnitude - lastMagnitude);
    lastMagnitude = magnitude;
    if (delta > 1.45) {
      void maybeLaunchFeedbackFromShake("shake", userId);
    }
  });

  void (async () => {
    try {
      const pending = await (NativeModules as any)?.YaverInfo?.consumePendingFeedbackLaunch?.();
      if (pending) {
        await maybeLaunchFeedbackFromShake("native-guest-shake", userId);
      }
    } catch {
      // ignore
    }
  })();

  // Android: subscribe to YaverShakeDetector's native event. The
  // native side does TWO things on shake (see YaverShakeDetectorModule.kt):
  //   - guest bundle loaded → persist a pending-feedback flag, unload
  //     the guest natively, and recreate into Yaver's own bundle.
  //     The startup/app-active consumePendingFeedbackLaunch() path
  //     above then re-enters maybeLaunchFeedbackFromShake with
  //     source = "native-guest-shake", bypassing the Settings gate
  //     and preserving guest-aware feedback routing.
  //   - no guest active → emit YaverShakeDetected; JS picks it up
  //     here and routes through `maybeLaunchFeedbackFromShake` with
  //     source = "shake" so the SETTINGS GATE applies. The user has
  //     to have explicitly enabled feedback + trigger:"shake" in
  //     Settings → Feedback SDK for the overlay to open. Otherwise
  //     shaking the standalone Yaver app silently no-ops — matching
  //     the user's product intent (feedback overlay is opt-in, not
  //     surprise-on-every-shake).
  let nativeShakeSub: { remove: () => void } | null = null;
  if (Platform.OS === "android") {
    const detector = (NativeModules as any)?.YaverShakeDetector;
    if (detector) {
      const emitter = new NativeEventEmitter(detector);
      nativeShakeSub = emitter.addListener("YaverShakeDetected", () => {
        if (appState !== "active") return;
        void maybeLaunchFeedbackFromShake("shake", userId);
      });
    }
  }

  return () => {
    accelSub.remove();
    appStateSub.remove();
    nativeShakeSub?.remove();
  };
}
