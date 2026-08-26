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
};

/** Probe the exact URL the phone will hand to its WebView. The box-local
 * browser doctor cannot see a relay-prefix mistake, so it cannot replace this
 * transport-side operation check. */
export async function probeAgentPreviewRoute(
  url: string,
  headers: Record<string, string>,
  request: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<AgentPreviewRouteProbe> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const timeout = setTimeout(() => controller?.abort(), timeoutMs);
  try {
    const response = await request(url, {
      method: "HEAD",
      headers: { ...headers, "Cache-Control": "no-cache" },
      signal: controller?.signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      contentType: String(response.headers.get("content-type") || "unknown").split(";")[0],
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      contentType: "unknown",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}
