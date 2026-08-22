import type { QuicClient } from "./quic";

export type BrowserLaneProbeStage =
  | "no-url"
  | "no-browser"
  | "navigate"
  | "http"
  | "compiling"
  | "blank"
  | "rendered"
  | string;

export interface BrowserLaneProbeResult {
  ok: boolean;
  stage: BrowserLaneProbeStage;
  url?: string;
  httpStatus?: number;
  detail?: string;
  remedy?: string;
  elapsedMs?: number;
  bodyPreview?: string;
}

export interface BrowserClientProbe {
  reason?: string;
  mountId?: string;
  mountChildren?: number;
  bodyChildren?: number;
}

const clientRenderedReasons = new Set([
  "flutter_engine_attached",
  "mount_has_visible_content",
  "mount_without_visible_content",
  "plain_body_content",
]);

/** The agent doctor runs beside the app on the box; the WebView probe measures
 *  the operation on the phone, including the relay and every sub-resource.
 *  A local rendered verdict can therefore never overrule a phone that still
 *  has an empty mount. This is the inventory-vs-operation seam from the
 *  2026-08-22 first-load failure. */
export function reconcileBrowserLaneProbe(
  agentProbe: BrowserLaneProbeResult,
  clientProbe: BrowserClientProbe | null | undefined,
): BrowserLaneProbeResult {
  const reason = String(clientProbe?.reason || "").trim();
  if (!agentProbe.ok || !reason || clientRenderedReasons.has(reason)) return agentProbe;

  const clientDetail = clientProbe?.mountId
    ? `#${clientProbe.mountId} children ${clientProbe.mountChildren ?? 0}`
    : `body children ${clientProbe?.bodyChildren ?? 0}`;
  return {
    ...agentProbe,
    ok: false,
    stage: "client-render",
    detail: `The box rendered locally, but this device reports ${reason} (${clientDetail}).`,
    remedy: "The phone did not receive or execute the complete browser bundle. Retry the preview; if a script keeps failing, open Logs and use Fix in Yaver.",
  };
}

/** A failed entry script before first paint is usually the cold-compile race:
 *  index.html arrived, its bundle did not, then Metro finished without the
 *  document requesting that script again. Reloading the document is the
 *  deterministic repair; never do it after paint because that would discard
 *  the user's live app state. */
export function shouldRetryBrowserResourceFailure(input: {
  tag?: string;
  contentLoaded: boolean;
}): boolean {
  return !input.contentLoaded && String(input.tag || "").toUpperCase() === "SCRIPT";
}

export async function doctorBrowserLane(
  client: Pick<QuicClient, "baseUrl" | "getAuthHeaders">,
  waitSeconds = 60,
): Promise<BrowserLaneProbeResult | null> {
  const safeWait = Math.max(1, Math.min(300, Math.round(waitSeconds)));
  try {
    const res = await fetch(`${client.baseUrl}/doctor/browser-lane?waitSeconds=${safeWait}`, {
      headers: client.getAuthHeaders(),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function browserLaneProbeLine(probe: BrowserLaneProbeResult): string {
  const bits = [`[doctor] browser lane stage=${probe.stage || "unknown"}`];
  if (typeof probe.httpStatus === "number" && probe.httpStatus > 0) bits.push(`http=${probe.httpStatus}`);
  if (typeof probe.elapsedMs === "number" && probe.elapsedMs > 0) bits.push(`${Math.round(probe.elapsedMs)}ms`);
  if (probe.detail) bits.push(probe.detail);
  if (probe.remedy) bits.push(`remedy: ${probe.remedy}`);
  return bits.join(" · ");
}

export function shouldRunBrowserLaneDoctor(input: {
  showWebView: boolean;
  bundleUrl: string;
  contentLoaded: boolean;
  failed: boolean;
  serverLooksReady: boolean;
  logLine?: string;
}): boolean {
  if (!input.showWebView || !input.bundleUrl || input.contentLoaded) return false;
  if (input.failed && input.serverLooksReady) return true;
  const line = String(input.logLine || "").toLowerCase();
  return input.serverLooksReady && /\b(resource failed|script|unhandled rejection|uncaught|typeerror|referenceerror)\b/.test(line);
}
