import type { DevReloadResult, DevServerStatus } from "./quic";
import { mustUseNativePreview } from "./devLane";

export type PreviewReloadKind = "fast" | "full";
export type PreviewReloadLane = "browser" | "native-hermes";

export interface PreviewReloadPlan {
  lane: PreviewReloadLane;
  mode: "fast" | "full" | "bundle";
  allowBundleFallback: boolean;
  shouldShowBrowserLoading: boolean;
  shouldOpenNativeFirst: boolean;
}

/**
 * Shared Fast/Full reload routing for Yaver's mobile preview surfaces.
 *
 * Browser/WebView previews must stay in the browser lane. Falling through to
 * /dev/reload-app asks the agent to validate Hermes/mobile SDK listeners, which
 * is exactly how a healthy browser preview turned into "No mobile SDK listener
 * or browser bundle preview is connected" over a good todo-rn screen.
 */
export function planPreviewReload(input: {
  status?: Pick<DevServerStatus, "framework" | "platform" | "devMode" | "building"> | null;
  kind?: PreviewReloadKind;
  bundleMounted?: boolean;
  nativeLoading?: boolean;
  reloadLoading?: boolean;
}): PreviewReloadPlan | null {
  if (input.reloadLoading || input.nativeLoading) return null;

  const kind = input.kind ?? "fast";
  const nativeLane = mustUseNativePreview({
    framework: input.status?.framework,
    platform: input.status?.platform,
    devMode: input.status?.devMode,
    building: input.status?.building,
  });

  if (!nativeLane) {
    return {
      lane: "browser",
      mode: kind,
      allowBundleFallback: false,
      shouldShowBrowserLoading: true,
      shouldOpenNativeFirst: false,
    };
  }

  return {
    lane: "native-hermes",
    mode: kind === "full" ? "bundle" : "fast",
    allowBundleFallback: true,
    shouldShowBrowserLoading: false,
    shouldOpenNativeFirst: !input.bundleMounted,
  };
}

// ── Post-task render: which surface refreshes when a coding turn lands ───────
//
// This encodes the defect that made "vibe on Yaver and watch it update"
// impossible, so it cannot come back silently.
//
// Until 2026-08-02 the ONLY post-task render path on mobile was
// rerenderActiveRemoteRuntimeSurface() — WebRTC, and gated further to
// simulator/emulator targets (canRunGuestOnRemoteTarget). Two consequences:
//
//  1. A BROWSER-lane preview never refreshed when a task finished. DevPreview
//     does not know a coding turn exists; nothing else was listening.
//  2. For Yaver-on-Yaver — whose only offered lane was WebRTC on a *browser*
//     target — the target check failed and the function returned `false` with
//     no log at all. Task completes, nothing renders, nothing explains.
//
// So the decision now lives here: pure, total (every branch returns a sentence),
// and tested. A skip is never silent — the caller has a message to show.

export type PostTaskRenderLane = "browser" | "webrtc";

export type PostTaskRenderSkip =
  | "not-terminal"       // turn still running; queue, don't render
  | "no-active-surface"  // nothing is open to refresh
  | "target-cannot-render"
  | "already-in-flight";

export type PostTaskRenderDecision =
  | { action: "render"; lane: PostTaskRenderLane }
  | { action: "skip"; reason: PostTaskRenderSkip; message: string };

/**
 * Terminal-and-renderable task states. Mid-turn renders are forbidden by the
 * no-surprise-re-render rule: queue the intent, keep the last good surface, and
 * refresh exactly once when the turn lands.
 */
export function taskStatusAllowsPostTaskRender(status?: string | null): boolean {
  const s = String(status || "").toLowerCase();
  return s === "completed" || s === "review";
}

export function planPostTaskRender(input: {
  /** Which preview surface is currently open, if any. */
  lane: PostTaskRenderLane | null;
  taskStatus?: string | null;
  /** WebRTC lane only: whether a session exists and whether its target can
   *  actually be re-rendered (browser targets reject `run-guest`). */
  hasWebrtcSession?: boolean;
  webrtcTargetCanRender?: boolean;
  webrtcTargetLabel?: string;
  inFlight?: boolean;
}): PostTaskRenderDecision {
  if (!taskStatusAllowsPostTaskRender(input.taskStatus)) {
    return {
      action: "skip",
      reason: "not-terminal",
      message: "Change queued — the preview refreshes once this turn finishes.",
    };
  }
  if (input.inFlight) {
    return {
      action: "skip",
      reason: "already-in-flight",
      message: "A refresh is already running; this one was coalesced into it.",
    };
  }
  if (!input.lane) {
    return {
      action: "skip",
      reason: "no-active-surface",
      message: "Nothing to refresh — no preview is open. Open the preview to see this change.",
    };
  }
  if (input.lane === "browser") {
    return { action: "render", lane: "browser" };
  }
  if (!input.hasWebrtcSession) {
    return {
      action: "skip",
      reason: "no-active-surface",
      message: "The streamed session ended before the turn landed. Reopen it to see this change.",
    };
  }
  if (!input.webrtcTargetCanRender) {
    const target = input.webrtcTargetLabel ? ` (${input.webrtcTargetLabel})` : "";
    return {
      action: "skip",
      reason: "target-cannot-render",
      message:
        `This streamed target${target} can't be re-rendered in place — that command is for ` +
        "simulators and emulators. Use Browser Reload for a web-served preview.",
    };
  }
  return { action: "render", lane: "webrtc" };
}

export function previewReloadReachedTarget(result: DevReloadResult | null | undefined): boolean {
  if (!result?.ok) return false;
  if (result.reloadTarget === "none") return false;
  if (result.transport === "web-bundle") return true;
  if (typeof result.deliveredTo === "number") return result.deliveredTo > 0;
  return true;
}

export function previewReloadFailureLine(result: DevReloadResult | null | undefined): string {
  return `Reload failed: ${describePreviewReloadResult(result)}`;
}

export function describePreviewReloadResult(result: DevReloadResult | null | undefined): string {
  if (!result) return "Reload status unavailable.";
  if (result.message) return result.message;
  if (result.error) return result.error;
  if (result.reloadTarget === "web-bundle-preview") return "Browser preview refreshed from the latest web bundle.";
  if (result.reloadTarget === "preview-worker") return "Preview worker reload command sent.";
  if (result.reloadTarget === "sdk-listeners") {
    const n = typeof result.deliveredTo === "number" ? result.deliveredTo : 0;
    return n === 1 ? "Native reload delivered to 1 app session." : `Native reload delivered to ${n} app sessions.`;
  }
  if (result.reloadTarget === "none") return "No active app or browser preview was available to reload.";
  return result.ok ? "Reload command sent." : "Reload failed.";
}
