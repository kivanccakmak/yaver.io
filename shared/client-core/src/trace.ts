/**
 * trace.ts — one shared paste-ready trace assembler for every surface.
 *
 * WHY (2026-08-09): a crash/failure on web, mobile, or the console used to
 * copy different things — RawFailureBanner copied just `failure.raw`, the
 * mobile Logs sheet copied `combinedLogText`, RuntimeLab copied raw console
 * lines. None carried the surface identity, versions, task id, runner/model,
 * or the log tail, so pasting into an issue or a vibing follow-up lost the
 * context that makes a bug reproducible. One assembler here gives every
 * surface the SAME structured blob (surface → versions → device/relay →
 * task → error → log tail), so web and mobile can never drift
 * (AGENTS.md: one shared classifier, no copies). Mirrored into
 * mobile/src/_core and web/lib/_core by scripts/sync-client-core.sh.
 */

export interface TraceContext {
  /** Surface name: "web" | "mobile" | "console" | "cli" | "watch" ... */
  surface: string;
  /** e.g. web build label, mobile JS bundle version, cli version. */
  surfaceVersion?: string;
  /** Agent version reported by /info (e.g. "1.99.409"). */
  agentVersion?: string;
  /** Device the task ran on (name + id). */
  device?: string;
  /** Relay region / id if known. */
  relay?: string;
  /** Task identity + lifecycle. */
  task?: {
    id: string;
    status?: string;
    runner?: string;
    model?: string;
    title?: string;
  };
  /** The human-readable error (already extracted/named). */
  error?: string;
  /** Raw failure blob (the undecorated original). */
  raw?: string;
  /** Log tail — last N lines of the relevant log (agent/relay/runtime). */
  logTail?: string;
  /** When the trace was captured (ms epoch). */
  ts?: number;
}

const MASK = /token\s*[=:]\s*\S+|Bearer\s+\S+|api[_-]?key\s*[=:]\s*\S+|password\s*[=:]\s*\S+/gi;

function sanitize(s: string): string {
  return String(s || "").replace(MASK, "[redacted]");
}

/**
 * Assemble a paste-ready trace. Every present field becomes one labelled
 * line; nothing is ever invented. Returns a plain-text blob.
 */
export function assembleTrace(ctx: TraceContext): string {
  const out: string[] = [];
  out.push("--- Yaver trace ---");
  out.push(`surface: ${sanitize(ctx.surface)}`);
  if (ctx.surfaceVersion) out.push(`surface.version: ${sanitize(ctx.surfaceVersion)}`);
  if (ctx.agentVersion) out.push(`agent.version: ${sanitize(ctx.agentVersion)}`);
  if (ctx.device) out.push(`device: ${sanitize(ctx.device)}`);
  if (ctx.relay) out.push(`relay: ${sanitize(ctx.relay)}`);
  if (ctx.task) {
    out.push(`task: ${sanitize(ctx.task.id)}${ctx.task.status ? ` status=${sanitize(ctx.task.status)}` : ""}${ctx.task.runner ? ` runner=${sanitize(ctx.task.runner)}` : ""}${ctx.task.model ? ` model=${sanitize(ctx.task.model)}` : ""}${ctx.task.title ? ` title=${sanitize(ctx.task.title)}` : ""}`);
  }
  if (ctx.error) out.push(`error: ${sanitize(ctx.error)}`);
  if (ctx.raw) out.push(`raw: ${sanitize(ctx.raw)}`);
  if (ctx.logTail) out.push(`log-tail:\n${sanitize(ctx.logTail)}`);
  out.push(`ts: ${ctx.ts ?? Date.now()}`);
  return out.join("\n");
}
