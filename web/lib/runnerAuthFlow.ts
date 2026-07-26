// runnerAuthFlow.ts — WHICH completion affordance a runner OAuth session
// needs, derived from the auth URL's redirect_uri.
//
// The 2026-07-27 failure: `claude auth login --claudeai` printed an OAuth
// URL whose redirect_uri is https://platform.claude.com/oauth/code/callback
// — the user signs in, platform.claude.com shows a CODE, and the CLI waits
// for that code on stdin. The dashboard panel offered only the
// localhost-callback box ("paste the address from localhost:39131"), whose
// validator rightly rejects anything that isn't http://localhost:<port> —
// so the user "got a token but it failed", steered into the wrong slot by
// the UI. The two flows need different inputs, and the URL says which.

export type RunnerAuthFlowKind = "code-paste" | "localhost-callback" | "unknown";

export function runnerAuthFlowKind(openUrl?: string | null): RunnerAuthFlowKind {
  const url = (openUrl || "").trim();
  if (!url) return "unknown";
  let redirect = "";
  try {
    redirect = new URL(url).searchParams.get("redirect_uri") || "";
  } catch {
    // Not parseable — fall through to substring checks on the raw string.
  }
  const probe = (redirect || url).toLowerCase();
  if (probe.includes("platform.claude.com/oauth/code") || /[?&]code=true/.test(url)) {
    return "code-paste";
  }
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/.test(redirect.toLowerCase())) {
    return "localhost-callback";
  }
  return "unknown";
}
