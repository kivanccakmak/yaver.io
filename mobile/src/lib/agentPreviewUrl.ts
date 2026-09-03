// Keep agent-relative preview routes inside the selected device's transport
// base. A relay client lives below /d/<device>; URL("/dev-web/", base) silently
// drops that prefix and sends the WebView to the relay root, which answers 404.
// The agent owns the route path, but never the origin.
export function resolveAgentPreviewUrl(baseUrl: string, reportedPath: string): string {
  const base = new URL(baseUrl);
  const reported = new URL(reportedPath, base.origin);
  const basePath = base.pathname.replace(/\/+$/, "");
  const reportedPathname = reported.pathname || "/";
  const alreadyScoped = basePath !== "" &&
    (reportedPathname === basePath || reportedPathname.startsWith(`${basePath}/`));

  base.pathname = alreadyScoped
    ? reportedPathname
    : `${basePath}/${reportedPathname.replace(/^\/+/, "")}`;
  base.search = reported.search;
  base.hash = reported.hash;
  return base.toString();
}

export type AgentPreviewRouteProbe = {
  ok: boolean;
  status: number;
  contentType: string;
  error?: string;
  transient?: boolean;
  state?: string;
  timedOut?: boolean;
  attempts?: number;
};

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Probe the exact URL the phone will hand to its WebView. The box-local
 * browser doctor cannot see a relay-prefix mistake, so it cannot replace this
 * transport-side operation check. */
export async function probeAgentPreviewRoute(
  url: string,
  headers: Record<string, string>,
  request: typeof fetch = fetch,
  timeoutMs = 15_000,
  signal?: AbortSignal,
): Promise<AgentPreviewRouteProbe> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const timeout = setTimeout(() => controller?.abort(), timeoutMs);
  const forwardAbort = () => controller?.abort();
  if (signal?.aborted) controller?.abort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    const response = await request(url, {
      // Use the same operation as the WebView. A HEAD can report that the
      // socket exists without asking Expo to serve the HTML that starts its
      // first compile.
      method: "GET",
      headers: { ...headers, "Cache-Control": "no-cache" },
      signal: controller?.signal,
    });
    const state = String(response.headers.get("x-yaver-devserver") || "").trim().toLowerCase();
    const retryAfter = String(response.headers.get("retry-after") || "").trim();
    const transient = response.status === 502 || response.status === 504 ||
      (response.status === 503 && (state === "starting" || retryAfter !== ""));
    return {
      ok: response.ok,
      status: response.status,
      contentType: String(response.headers.get("content-type") || "unknown").split(";")[0],
      ...(transient ? { transient: true } : {}),
      ...(state ? { state } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      contentType: "unknown",
      error: error instanceof Error ? error.message : String(error),
      transient: true,
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

/**
 * Wait for the exact phone-facing preview route to serve HTML.
 *
 * `/dev/start` is deliberately asynchronous. On a cold Expo build the route
 * therefore answers a structured 503 for tens of seconds before becoming
 * healthy. That is progress, not a terminal renderer failure. Authentication,
 * routing and request errors (401/403/404/5xx other than gateway availability)
 * still fail immediately; only the bounded startup statuses are retried.
 */
export async function waitForAgentPreviewRoute(
  url: string,
  headers: Record<string, string>,
  onWaiting?: (probe: AgentPreviewRouteProbe, elapsedMs: number, attempt: number) => void,
  options: {
    request?: typeof fetch;
    timeoutMs?: number;
    attemptTimeoutMs?: number;
    intervalMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<AgentPreviewRouteProbe> {
  const request = options.request || fetch;
  const timeoutMs = Math.max(1, options.timeoutMs ?? 120_000);
  const attemptTimeoutMs = Math.max(1, options.attemptTimeoutMs ?? 15_000);
  const intervalMs = Math.max(0, options.intervalMs ?? 1_500);
  const startedAt = Date.now();
  let attempt = 0;

  while (true) {
    if (options.signal?.aborted) {
      return { ok: false, status: 0, contentType: "unknown", error: "Dogfood launch stopped", attempts: attempt };
    }
    attempt += 1;
    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(1, timeoutMs - elapsed);
    const probe = await probeAgentPreviewRoute(url, headers, request, Math.min(attemptTimeoutMs, remaining), options.signal);
    if (probe.ok || !probe.transient) return { ...probe, attempts: attempt };

    const afterProbeElapsed = Date.now() - startedAt;
    onWaiting?.(probe, afterProbeElapsed, attempt);
    if (afterProbeElapsed >= timeoutMs) return { ...probe, timedOut: true, attempts: attempt };
    await waitForRetry(Math.min(intervalMs, timeoutMs - afterProbeElapsed), options.signal);
  }
}
