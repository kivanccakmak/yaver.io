/**
 * runnerOutputNoise — subprocess chatter that must NEVER be shown as a failure.
 *
 * ── The incident (2026-08-02) ──────────────────────────────────────────────
 *
 * A Vibing run against ubuntu printed this into the chat, verbatim, in red:
 *
 *   ERROR rmcp::transport::worker: worker quit with fatal: Transport channel
 *   closed, when UnexpectedServerResponse("HTTP 401: {... "code":
 *   "token_expired" ...}")
 *   ERROR codex_api::endpoint::responses_websocket: failed to connect to
 *   websocket: HTTP error: 401 Unauthorized
 *
 * The owner reasonably read that as a failure and reported it as one. It was
 * not. Codex retried past it, ran the task, and patched the file it was asked
 * to patch. The run SUCCEEDED.
 *
 * So Yaver took a working system and rendered it as broken — a false red of the
 * most expensive kind, because it also sent an investigation (several, in fact)
 * chasing an auth problem that was not blocking anything.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *
 * A line from a runner's INTERNAL transport plumbing is not the task's verdict.
 * Codex runs an MCP sidecar and a websocket channel; both log loudly and both
 * retry. Their chatter belongs in the console, never in the transcript as a
 * result, and never as the thing that decides a FAILED badge.
 *
 * The verdict comes from the TASK's terminal state. This module only decides
 * what is safe to demote to noise while the task is still alive.
 *
 * ── Why this is not just "hide errors" ─────────────────────────────────────
 *
 * The same 401 IS meaningful when the task actually fails — then the auth
 * classifier should see it and route to sign-in. So demotion is conditional on
 * the task not having terminally failed. Hiding it unconditionally would swap
 * a false red for a false green, which is worse.
 */

/** Log prefixes that belong to a runner's internal plumbing, not its result. */
const SIDECAR_PREFIXES = [
  "rmcp::transport",
  "rmcp::service",
  "codex_api::endpoint",
  "mcp::transport",
];

/** Phrases that mark a line as retryable transport chatter. */
const TRANSPORT_CHATTER = [
  "worker quit with fatal: transport channel closed",
  "failed to connect to websocket",
  "unexpectedserverresponse",
  "reconnecting",
];

/**
 * True when a single output line is runner-internal transport chatter.
 *
 * Deliberately requires BOTH a known sidecar prefix AND transport wording. A
 * bare "401 Unauthorized" from the task itself is a real failure and must not
 * match here — matching on the status code alone would silence the very thing
 * the auth classifier exists to catch.
 */
export function isRunnerSidecarNoise(line: string | null | undefined): boolean {
  const l = String(line || "").toLowerCase();
  if (!l.trim()) return false;
  const hasPrefix = SIDECAR_PREFIXES.some((p) => l.includes(p));
  if (!hasPrefix) return false;
  return TRANSPORT_CHATTER.some((c) => l.includes(c));
}

/**
 * Split output into what a user should SEE and what belongs in the console.
 *
 * `terminallyFailed` is the gate: while a task is alive, sidecar chatter is
 * demoted; once it has actually failed, everything is surfaced so the auth
 * classifier and the user both get the full picture.
 */
export function partitionRunnerOutput(
  output: string | null | undefined,
  terminallyFailed: boolean,
): { visible: string; noise: string[] } {
  const lines = String(output || "").split("\n");
  if (terminallyFailed) return { visible: lines.join("\n"), noise: [] };
  const visible: string[] = [];
  const noise: string[] = [];
  for (const line of lines) {
    if (isRunnerSidecarNoise(line)) noise.push(line);
    else visible.push(line);
  }
  return { visible: visible.join("\n"), noise };
}

/**
 * A short, honest status line for demoted chatter — so the console is not
 * silently lighter than what happened.
 *
 * Silence would be its own defect: the user saw something scroll past and needs
 * to know where it went. This says what was set aside and why, without dressing
 * retryable plumbing up as a problem.
 */
export function describeSidecarNoise(noise: readonly string[]): string | null {
  if (!noise.length) return null;
  const n = noise.length;
  return `${n} runner transport ${n === 1 ? "message" : "messages"} (MCP sidecar / websocket) hidden — the runner retries these internally and the task is still going. They are in the runtime console.`;
}
