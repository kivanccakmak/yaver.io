// agentAuthError.ts — ONE matcher for "this failure is the agent's auth, not
// the operation" (failure-recovery audit 2026-07 §6 item 4).
//
// This predicate started life file-local to RuntimeLabView.tsx, which meant
// only the Load Targets flow could tell an expired Convex session apart from
// a broken probe: ProjectsView's inventory, PreviewPane's task create, and
// VibeCodingView's sends all rendered the raw "HTTP 401" (or worse, the
// generic fallback string) with no reconnect CTA. A dashboard where one panel
// diagnoses auth and four panels shrug at the same byte-identical error is
// the cross-surface-parity defect in miniature — hoisted here so every view
// consumes the same truth.
//
// Keep this in sync with the agent's actual failure shapes:
//   - `invalid token` / `unauthorized` / `forbidden` — agent HTTP auth reject
//   - `session expired` / `agent auth expired` / `convex session is expired`
//     — the /health authExpired lane and agent-client's connect error text
//   - bare `http 401` / `http 403` — responseErrorMessage's fallback when the
//     body carried no detail

export function isAgentAuthErrorMessage(message: string | null | undefined): boolean {
  const lower = String(message || "").toLowerCase();
  return (
    lower.includes("invalid token") ||
    lower.includes("session expired") ||
    lower.includes("agent auth expired") ||
    lower.includes("convex session is expired") ||
    lower.includes("http 401") ||
    lower.includes("http 403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  );
}

/** The standard remedy sentence to render next to an auth-shaped failure —
 *  names the fix instead of leaving a raw status code on screen. */
export const AGENT_AUTH_REMEDY =
  "Agent auth expired or mismatched. Reconnect this machine (or run `yaver auth` on it), then retry.";
