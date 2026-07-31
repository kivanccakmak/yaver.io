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
