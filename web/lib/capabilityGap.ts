// capabilityGap.ts — ONE renderer for "this machine is missing something, and
// here is the tap that fixes it".
//
// The producer is desktop/agent/capability_gap.go. It carries the gap on three
// channels — the /dev/start 412 body, the /dev/events SSE `error` frame, and
// /dev/status — all as the SAME object, so this file is the only place either
// client has to know the shape.
//
// WHY THIS EXISTS. On 2026-07-26 the agent said `exec flutter: executable file
// not found in $PATH` for a Flutter project on a box without Flutter, and the
// phone showed "Waiting for the dev server to report its address…". POST
// /install/flutter worked the whole time. The remedy string the agent produced
// even read "use Install on the preview panel, which streams the download" —
// and there was no Install button on any preview panel on any surface. A
// truthful agent plus a client that drops the truth is still a spinner over a
// known fact.
//
// THE RULE THIS ENFORCES: clients LOOK UP a code, they never regex prose. The
// codebase already carries three non-overlapping vocabularies for "what went
// wrong" and a dozen drifting substring matchers; `code` is the wire contract
// and does not get rewritten the way a sentence does.
//
// KEEP IN SYNC with mobile/src/lib/capabilityGap.ts — byte-identical below the
// header comment, pinned by mobile/src/lib/capabilityGap.test.mts. Two surfaces,
// one renderer, or "named on one surface only" ships again.

/** The wire code for a missing toolchain. Mirrors
 *  desktop/agent/reason_codes.go ReasonCapabilityToolchainMissing. */
export const CAPABILITY_TOOLCHAIN_MISSING = "capability.toolchain_missing";

/** The ROUTE. method + path + stream is what makes a remedy tappable. */
export type GapFix = {
  label: string;
  method: string;
  path: string;
  /** log-stream NAME, e.g. "install:flutter"; served at GET /streams/<stream> */
  stream: string;
  est?: string;
  retry?: boolean;
};

export type CapabilityGap = {
  code: string;
  capability: string;
  summary: string;
  detail?: string;
  /** null/absent ⇒ no fixer exists here; `constraint` says why. */
  fix?: GapFix | null;
  constraint?: string;
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Parse an agent-supplied gap. Returns null for anything that is not one —
 *  a half-formed object must not render as a button that goes nowhere. */
export function parseCapabilityGap(raw: unknown): CapabilityGap | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const code = str(o.code);
  const summary = str(o.summary);
  if (!code || !summary) return null;
  const gap: CapabilityGap = {
    code,
    capability: str(o.capability),
    summary,
    detail: str(o.detail) || undefined,
    constraint: str(o.constraint) || undefined,
  };
  const rawFix = o.fix;
  if (rawFix && typeof rawFix === "object") {
    const f = rawFix as Record<string, unknown>;
    const path = str(f.path);
    const stream = str(f.stream);
    // No path or no stream = an install the user could start and never see.
    // That is the "silent 1.2 GB download" defect; refuse to render it.
    if (path && stream) {
      gap.fix = {
        label: str(f.label) || "Install",
        method: str(f.method) || "POST",
        path,
        stream,
        est: str(f.est) || undefined,
        retry: f.retry === true,
      };
    }
  }
  return gap;
}

/** The gap on a /dev/events frame (`{type:"error", gap:{…}}`), or null. */
export function capabilityGapFromDevEvent(event: unknown): CapabilityGap | null {
  if (!event || typeof event !== "object") return null;
  return parseCapabilityGap((event as Record<string, unknown>).gap);
}

/** The gap on a /dev/status poll (`{capabilityGap:{…}}`), or null. */
export function capabilityGapFromStatus(status: unknown): CapabilityGap | null {
  if (!status || typeof status !== "object") return null;
  return parseCapabilityGap((status as Record<string, unknown>).capabilityGap);
}

/** The gap on a thrown /dev/start refusal. Accepts both the parsed 412 body
 *  and an Error the transport decorated with it. */
export function capabilityGapFromError(err: unknown): CapabilityGap | null {
  if (!err || typeof err !== "object") return null;
  const o = err as Record<string, unknown>;
  return parseCapabilityGap(o.capabilityGap) || parseCapabilityGap(o.gap);
}

/** The headline sentence. */
export function gapTitle(gap: CapabilityGap): string {
  return gap.summary;
}

/** The body: what tapping the button will do, or why there is no button. */
export function gapBody(gap: CapabilityGap): string {
  return gap.detail || gap.constraint || "";
}

/** Button label, or null when there is no route (render `constraint` instead). */
export function gapFixLabel(gap: CapabilityGap | null | undefined): string | null {
  if (!gap || !gap.fix) return null;
  const est = gap.fix.est ? ` · ${gap.fix.est}` : "";
  return gap.fix.label + est;
}

/** The URL to subscribe to for the fix's live output, relative to the agent. */
export function gapStreamPath(gap: CapabilityGap | null | undefined): string | null {
  if (!gap || !gap.fix || !gap.fix.stream) return null;
  return "/streams/" + gap.fix.stream;
}

/** The tool name POST /install/<tool> wants, derived from the fix path so no
 *  caller re-parses it. Null when the fix is not an install route. */
export function gapInstallTool(gap: CapabilityGap | null | undefined): string | null {
  if (!gap || !gap.fix) return null;
  const path = gap.fix.path.trim();
  if (!path.startsWith("/install/")) return null;
  const tool = path.slice("/install/".length).replace(/\/+$/, "");
  return tool || null;
}

/** True when the surface should re-issue the original request once the fix
 *  reports success — "return them to what they were doing". */
export function gapRetriesAfterFix(gap: CapabilityGap | null | undefined): boolean {
  return Boolean(gap && gap.fix && gap.fix.retry);
}
