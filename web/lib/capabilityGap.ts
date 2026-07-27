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

/** "Installable here, and this machine has no room." A DIFFERENT code from
 *  toolchain_missing on purpose: the remedy is reclaiming space, not an
 *  install, and rendering one for the other sends the user to press a button
 *  that cannot help. Mirrors ReasonCapabilityInsufficientDisk. */
export const CAPABILITY_INSUFFICIENT_DISK = "capability.insufficient_disk";

/** The preview half of a DESTRUCTIVE route. A fix carrying this must not be
 *  invoked until the client has fetched `path` and shown the user exactly what
 *  would be deleted, with sizes. The agent enforces it too (the apply route
 *  refuses without `field`:true) — this tells the UI to render the preview, it
 *  does not grant permission. */
export type GapConfirm = {
  method: string;
  path: string;
  /** the JSON key the apply body must set to true, e.g. "confirm" */
  field: string;
  prompt: string;
};

/** The ROUTE. method + path + stream is what makes a remedy tappable. */
export type GapFix = {
  label: string;
  method: string;
  path: string;
  /** log-stream NAME, e.g. "install:flutter"; served at GET /streams/<stream>.
   *  Empty ONLY on a confirm-gated fix, which answers synchronously and is made
   *  visible by its preview instead. */
  stream: string;
  est?: string;
  retry?: boolean;
  confirm?: GapConfirm | null;
};

/** The headroom measurement behind a warning or a disk refusal. Bytes AND a
 *  pre-formatted string: two surfaces inventing two byte formatters is how the
 *  same machine reported "1.2 GB" and "1288490188" in one app. */
export type CapabilityResource = {
  path?: string;
  freeBytes: number;
  freeHuman: string;
  needBytes?: number;
  needHuman?: string;
  firstBuildBytes?: number;
  ramTotalBytes?: number;
  ramNeedBytes?: number;
  reclaimableBytes?: number;
  reclaimableHuman?: string;
  /** "ok" | "tight" | "insufficient" */
  level: string;
};

export type CapabilityGap = {
  code: string;
  capability: string;
  summary: string;
  detail?: string;
  /** null/absent ⇒ no fixer exists here; `constraint` says why. */
  fix?: GapFix | null;
  constraint?: string;
  /** Rides BESIDE a fix: the operation can start, and here is what may still
   *  go wrong ("3.1 GB free; the first build needs another 2 GB"). A warning is
   *  never a refusal — the button stays. */
  warning?: string;
  resource?: CapabilityResource | null;
  /** The space-freeing route offered when disk is the blocker or nearly is.
   *  Always confirm-gated. */
  reclaim?: GapFix | null;
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function parseGapFix(raw: unknown): GapFix | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const path = str(f.path);
  const stream = str(f.stream);
  if (!path) return null;

  let confirm: GapConfirm | null = null;
  const rawConfirm = f.confirm;
  if (rawConfirm && typeof rawConfirm === "object") {
    const c = rawConfirm as Record<string, unknown>;
    const cPath = str(c.path);
    // A confirm with no preview route is worse than no confirm: it would
    // render a "review first" affordance that reviews nothing.
    if (cPath) {
      confirm = {
        method: str(c.method) || "GET",
        path: cPath,
        field: str(c.field) || "confirm",
        prompt: str(c.prompt),
      };
    }
  }

  // No stream AND no confirm = an action the user could start and never see.
  // That is the "silent 1.2 GB download" defect; refuse to render it. A
  // confirm-gated fix is exempt: it answers synchronously and its preview is
  // what makes it visible.
  if (!stream && !confirm) return null;

  return {
    label: str(f.label) || "Install",
    method: str(f.method) || "POST",
    path,
    stream,
    est: str(f.est) || undefined,
    retry: f.retry === true,
    confirm,
  };
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
    warning: str(o.warning) || undefined,
  };
  gap.fix = parseGapFix(o.fix);
  gap.reclaim = parseGapFix(o.reclaim);

  const rawRes = o.resource;
  if (rawRes && typeof rawRes === "object") {
    const r = rawRes as Record<string, unknown>;
    const level = str(r.level);
    if (level) {
      gap.resource = {
        path: str(r.path) || undefined,
        freeBytes: num(r.freeBytes),
        freeHuman: str(r.freeHuman),
        needBytes: num(r.needBytes) || undefined,
        needHuman: str(r.needHuman) || undefined,
        firstBuildBytes: num(r.firstBuildBytes) || undefined,
        ramTotalBytes: num(r.ramTotalBytes) || undefined,
        ramNeedBytes: num(r.ramNeedBytes) || undefined,
        reclaimableBytes: num(r.reclaimableBytes) || undefined,
        reclaimableHuman: str(r.reclaimableHuman) || undefined,
        level,
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

/** What kind of thing this gap IS, so a surface renders one of four states
 *  instead of guessing from which fields happen to be set.
 *
 *  "constrained" is FIRST-CLASS and is not an error: it is a settled fact about
 *  this machine ("Xcode only exists on macOS"), and it ends a wait. Rendering
 *  it as a red error teaches the user something is broken; rendering it as a
 *  disabled button with no reason is the dead end CapabilityGap exists to
 *  abolish. Render the sentence, plainly, and stop spinning. */
export type GapState = "fixable" | "fixable-with-warning" | "constrained" | "unknown";

export function gapState(gap: CapabilityGap | null | undefined): GapState {
  if (!gap) return "unknown";
  if (gap.fix) return gap.warning ? "fixable-with-warning" : "fixable";
  if (gap.constraint) return "constrained";
  return "unknown";
}

/** The constraint sentence, or null. Null means "this is not a constrained
 *  gap" — never render an empty string as a state. */
export function gapConstraint(gap: CapabilityGap | null | undefined): string | null {
  if (!gap || gap.fix) return null;
  return gap.constraint ? gap.constraint : null;
}

/** The advisory that rides beside an available fix, or null. */
export function gapWarning(gap: CapabilityGap | null | undefined): string | null {
  if (!gap || !gap.warning) return null;
  return gap.warning;
}

/** True when disk space — not a missing toolchain — is what stopped this. */
export function gapIsDiskBlocked(gap: CapabilityGap | null | undefined): boolean {
  return Boolean(gap && (gap.code === CAPABILITY_INSUFFICIENT_DISK || gap.resource?.level === "insufficient"));
}

/** The reclaim button's label, or null when there is nothing to reclaim. */
export function gapReclaimLabel(gap: CapabilityGap | null | undefined): string | null {
  if (!gap || !gap.reclaim) return null;
  return gap.reclaim.label || "Free up space";
}

/** The route a surface MUST fetch before it may invoke a destructive fix.
 *  Null when the fix is not confirm-gated. A caller that skips this is asking
 *  the user to approve a deletion they were never shown. */
export function gapConfirmPreview(fix: GapFix | null | undefined): GapConfirm | null {
  if (!fix || !fix.confirm || !fix.confirm.path) return null;
  return fix.confirm;
}

/** One line of headroom the user can act on, or null when nothing was
 *  measured. Deliberately built from the agent's pre-formatted strings — a
 *  second byte formatter on the client is how two screens of one app disagree
 *  about the same disk. */
export function gapHeadroomLine(gap: CapabilityGap | null | undefined): string | null {
  const r = gap?.resource;
  if (!r || !r.freeHuman) return null;
  const where = r.path ? ` on ${r.path}` : "";
  let line = `${r.freeHuman} free${where}`;
  if (r.needHuman) line += ` · needs ${r.needHuman}`;
  if (r.reclaimableHuman) line += ` · about ${r.reclaimableHuman} reclaimable`;
  return line;
}
