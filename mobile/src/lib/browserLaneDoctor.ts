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

type BrowserLaneFetch = typeof fetch;

function safeProbeFailureDetail(status: number, body: unknown): string {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const code = String(record.code || record.reasonCode || "").trim();
  const message = String(record.message || record.error || "").trim();
  return [
    `The phone reached the browser-lane doctor, but it returned HTTP ${status}.`,
    code ? `Code: ${code}.` : "",
    message ? message.slice(0, 240) : "",
  ].filter(Boolean).join(" ");
}

function probeTransportRemedy(status?: number): string {
  if (status === 401 || status === 403) return "Reconnect this machine so Yaver refreshes the agent token and relay credential, then retry.";
  if (status === 429) return "The relay refused the probe because its request or bandwidth budget is exhausted; wait for the named limit to reset or use a direct connection.";
  if (status === 502 || status === 503 || status === 504) return "The relay could not complete the request to the agent. Reconnect the machine, then retry the same preview.";
  return "Reconnect the machine and retry. Keep Logs open so Yaver can report the exact failed stage.";
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

/** Probe the exact failed subresource through the phone's live transport.
 * HEAD avoids downloading a multi-megabyte Metro bundle while still crossing
 * the same relay, ownership, agent-auth, and /dev[-web] proxy seams. */
export async function probeBrowserResource(
  client: Pick<QuicClient, "getAuthHeaders">,
  bundleUrl: string,
  resourcePath: string,
  request: BrowserLaneFetch = fetch,
): Promise<BrowserLaneProbeResult> {
  const startedAt = Date.now();
  try {
    const page = new URL(bundleUrl);
    const target = new URL(resourcePath, page.origin);
    const lanePrefix = page.pathname.replace(/[^/]*$/, "");
    if (target.origin !== page.origin || !target.pathname.startsWith(lanePrefix) || !/\/dev(?:-web)?\//.test(target.pathname)) {
      return { ok: false, stage: "resource-path", detail: "The failed resource was outside this preview's scoped browser lane.", remedy: "Reload the preview from its project card." };
    }
    for (const key of ["token", "__rp", "access_token", "password", "secret", "key"]) target.searchParams.delete(key);
    const res = await request(target.toString(), {
      method: "HEAD",
      headers: { ...client.getAuthHeaders(), "Cache-Control": "no-cache" },
    });
    const contentType = String(res.headers.get("content-type") || "unknown").split(";")[0];
    const length = res.headers.get("content-length");
    if (!res.ok) {
      return {
        ok: false,
        stage: "resource-http",
        httpStatus: res.status,
        elapsedMs: Date.now() - startedAt,
        detail: `The phone reproduced the failed preview asset request: HTTP ${res.status} (${contentType}).`,
        remedy: probeTransportRemedy(res.status),
      };
    }
    return {
      ok: false,
      stage: "resource-delivery",
      httpStatus: res.status,
      elapsedMs: Date.now() - startedAt,
      detail: `The asset route answers HTTP ${res.status} (${contentType}${length ? `, ${length} bytes` : ""}), but this WebView did not execute it.`,
      remedy: "Reload the preview once. If it fails again, restart the machine connection so the WebView receives a fresh relay-auth cookie before loading the bundle.",
    };
  } catch (error) {
    return {
      ok: false,
      stage: "resource-transport",
      elapsedMs: Date.now() - startedAt,
      detail: `The phone could not probe the failed preview asset: ${error instanceof Error ? error.message : String(error)}`,
      remedy: probeTransportRemedy(),
    };
  }
}

export async function doctorBrowserLane(
  client: Pick<QuicClient, "baseUrl" | "getAuthHeaders">,
  waitSeconds = 60,
  request: BrowserLaneFetch = fetch,
  signal?: AbortSignal,
): Promise<BrowserLaneProbeResult> {
  const safeWait = Math.max(1, Math.min(300, Math.round(waitSeconds)));
  const startedAt = Date.now();
  const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const timeout = setTimeout(() => controller?.abort(), (safeWait + 20) * 1000);
  const forwardAbort = () => controller?.abort();
  if (signal?.aborted) controller?.abort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    const res = await request(`${client.baseUrl}/doctor/browser-lane?waitSeconds=${safeWait}`, {
      headers: client.getAuthHeaders(),
      signal: controller?.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        stage: "probe-http",
        httpStatus: res.status,
        elapsedMs: Date.now() - startedAt,
        detail: safeProbeFailureDetail(res.status, body),
        remedy: probeTransportRemedy(res.status),
      };
    }
    if (!body || typeof body !== "object" || typeof (body as BrowserLaneProbeResult).stage !== "string") {
      return {
        ok: false,
        stage: "probe-response",
        httpStatus: res.status,
        elapsedMs: Date.now() - startedAt,
        detail: "The browser-lane doctor returned a response without a structured stage.",
        remedy: "Update the Yaver agent, then retry the preview.",
      };
    }
    return body as BrowserLaneProbeResult;
  } catch (error) {
    const timedOut = controller?.signal.aborted === true;
    return {
      ok: false,
      stage: timedOut ? "probe-timeout" : "probe-transport",
      elapsedMs: Date.now() - startedAt,
      detail: timedOut
        ? `The phone waited ${safeWait + 20}s for the browser-lane doctor, but no response arrived.`
        : `The phone could not reach the browser-lane doctor: ${error instanceof Error ? error.message : String(error)}`,
      remedy: probeTransportRemedy(),
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", forwardAbort);
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
