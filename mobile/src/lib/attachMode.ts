// attachMode.ts — the "Yaver renders Yaver" mode, as pure policy.
//
// PURE + RN-free so the logic that SHIPS is the logic that's TESTED
// (`npx tsx src/lib/attachMode.test.mts`), mirroring boxInit.ts / connectGuard.ts.
//
// ── What the mode is ────────────────────────────────────────────────────────
//
// Attach Mode points the phone at Yaver's OWN mobile app, served as RN-web from
// a box over the browser lane, full-screen. You vibe from Tasks against the same
// checkout and the surface refreshes when the turn lands. The app you are
// looking at is the app being edited.
//
// ── Why the browser lane, and not Hermes ────────────────────────────────────
//
// Hermes is REFUSED for Yaver-on-Yaver (409 YAVER_SELF_DEVELOPMENT_RECURSION):
// loading Yaver into the Yaver container puts two shake/exit owners in one RN
// process, so the preview could not be exited. The web target has no such
// problem — a WebView cannot register a gesture handler on the host or draw
// over native chrome — which is why the refusal itself names it as the route.
//
// The escape therefore MUST live in native chrome OUTSIDE the WebView. That is
// not a UI preference; it is the property that makes this safe at all.
//
// ── The gate ────────────────────────────────────────────────────────────────
//
// Turning the mode on with nothing connected used to mean landing in a broken
// state with no route out. So enabling runs an ordered gate — box, then runner,
// then checkout — and every step reports what is wrong AND the action that
// fixes it. Readiness comes from computeBoxReadiness() (boxInit.ts) rather than
// a second opinion, so the two cannot drift.

import type { BoxReadiness } from "./boxInit";

/** Ordered steps. The order is the dependency order: a runner on an offline
 *  box is meaningless, and a checkout on a box with no runner cannot be vibed. */
export type AttachStepKey = "box" | "runner" | "checkout";

export type AttachStepStatus = "ok" | "blocked" | "pending";

/** Actions the surface can invoke. Mirrors boxInit's BoxActionId shape: a step
 *  that is not `ok` always names its fix. */
export type AttachActionId =
  | "none"
  | "pick_box"
  | "fix_box_readiness"
  | "pick_runner"
  | "set_checkout";

export interface AttachStep {
  key: AttachStepKey;
  label: string;
  status: AttachStepStatus;
  detail: string;
  action: AttachActionId;
}

export interface AttachGateInput {
  /** Chosen box, if the user has picked one. */
  deviceId?: string | null;
  deviceName?: string | null;
  /** Readiness for that box, from computeBoxReadiness(). Null while unknown. */
  readiness?: BoxReadiness | null;
  /** Chosen coding runner id ("claude-code" | "codex" | "opencode"). */
  runner?: string | null;
  /** Absolute path to the yaver.io checkout on that box. */
  checkoutDir?: string | null;
  /** The AGENT's verdict that checkoutDir really is Yaver's own checkout.
   *  Identity, never a client-side path guess — the agent reads package.json /
   *  app.json / the monorepo layout (IsYaverSelfDevelopmentDir). Undefined
   *  means "not asked yet". */
  checkoutVerified?: boolean;
}

export interface AttachGate {
  /** True only when every step is ok. */
  canAttach: boolean;
  steps: AttachStep[];
  /** The first step that needs attention — what the UI should focus. */
  nextStep: AttachStep | null;
}

function boxStep(input: AttachGateInput): AttachStep {
  if (!input.deviceId) {
    return {
      key: "box",
      label: "Box",
      status: "pending",
      detail: "no box selected",
      action: "pick_box",
    };
  }
  const name = input.deviceName || "the selected box";
  if (!input.readiness) {
    return {
      key: "box",
      label: "Box",
      status: "pending",
      detail: `checking ${name}…`,
      action: "none",
    };
  }
  if (input.readiness.overall === "not-ready") {
    // Reuse boxInit's own summary rather than inventing a second wording for
    // the same state — that is how two surfaces start disagreeing.
    const first = input.readiness.pending[0];
    return {
      key: "box",
      label: "Box",
      status: "blocked",
      detail: first ? `${name}: ${first.label} — ${first.detail}` : `${name} is not ready`,
      action: "fix_box_readiness",
    };
  }
  return { key: "box", label: "Box", status: "ok", detail: name, action: "none" };
}

function runnerStep(input: AttachGateInput): AttachStep {
  if (!input.deviceId) {
    return {
      key: "runner",
      label: "Runner",
      status: "pending",
      detail: "pick a box first",
      action: "none",
    };
  }
  if (!input.runner) {
    return {
      key: "runner",
      label: "Runner",
      status: "pending",
      detail: "no coding runner selected",
      action: "pick_runner",
    };
  }
  // The chosen runner must actually be ready ON THIS BOX. Accepting a runner
  // the box cannot run is the inventory-vs-operation mistake in miniature: the
  // picker says yes, the first coding turn says no.
  const matching = input.readiness?.checks.find((c) => runnerMatchesCheck(input.runner!, c.key));
  if (matching && matching.status !== "ok") {
    return {
      key: "runner",
      label: "Runner",
      status: "blocked",
      detail: `${matching.label}: ${matching.detail}`,
      action: "pick_runner",
    };
  }
  if (!matching && input.readiness) {
    // The box answered, and nothing it reported matches the chosen runner.
    return {
      key: "runner",
      label: "Runner",
      status: "blocked",
      detail: `this box does not report ${input.runner}`,
      action: "pick_runner",
    };
  }
  return {
    key: "runner",
    label: "Runner",
    status: "ok",
    detail: input.runner,
    action: "none",
  };
}

function runnerMatchesCheck(runner: string, key: string): boolean {
  const r = runner.toLowerCase();
  if (key === "claude") return r.includes("claude");
  if (key === "codex") return r.includes("codex");
  if (key === "opencode") return r.includes("opencode");
  return false;
}

function checkoutStep(input: AttachGateInput): AttachStep {
  if (!input.deviceId) {
    return {
      key: "checkout",
      label: "Yaver checkout",
      status: "pending",
      detail: "pick a box first",
      action: "none",
    };
  }
  if (!input.checkoutDir) {
    return {
      key: "checkout",
      label: "Yaver checkout",
      status: "pending",
      detail: "not set",
      action: "set_checkout",
    };
  }
  if (input.checkoutVerified === undefined) {
    return {
      key: "checkout",
      label: "Yaver checkout",
      status: "pending",
      detail: "verifying…",
      action: "none",
    };
  }
  if (!input.checkoutVerified) {
    // Say WHICH directory we wanted. "Invalid path" costs a support round-trip.
    return {
      key: "checkout",
      label: "Yaver checkout",
      status: "blocked",
      detail:
        `${input.checkoutDir} is not the Yaver checkout — Attach Mode needs the yaver.io ` +
        `directory whose mobile/package.json is named "yaver-mobile"`,
      action: "set_checkout",
    };
  }
  return {
    key: "checkout",
    label: "Yaver checkout",
    status: "ok",
    detail: input.checkoutDir,
    action: "none",
  };
}

export function computeAttachGate(input: AttachGateInput): AttachGate {
  const steps = [boxStep(input), runnerStep(input), checkoutStep(input)];
  const nextStep = steps.find((s) => s.status !== "ok") ?? null;
  return { canAttach: nextStep === null, steps, nextStep };
}

/** One-line summary for a collapsed row. */
export function attachGateSummary(gate: AttachGate): string {
  if (gate.canAttach) return "ready to attach";
  const next = gate.nextStep!;
  return next.status === "blocked" ? `${next.label}: ${next.detail}` : `next: ${next.label}`;
}

// ── Nesting ────────────────────────────────────────────────────────────────

/**
 * The attached Yaver can reach its own Settings, and could turn Attach Mode on
 * again — an infinite mirror, each layer heavier than the last.
 *
 * The guard is the sentinel the host seeds into the attached surface. It is
 * NOT a secret and carries no authority (the actual capability is an HttpOnly
 * cookie the page cannot read); it exists so the inner instance knows what it
 * is and can say so.
 */
export const ATTACH_SENTINEL_KEY = "yaver.attach.mode";

export interface NestingVerdict {
  /** May this instance offer Attach Mode at all? */
  mayOffer: boolean;
  /** Shown in place of the toggle when it may not. */
  reason?: string;
}

export function computeNestingVerdict(sentinel: string | null | undefined): NestingVerdict {
  if (sentinel === "1" || sentinel === "true") {
    return {
      mayOffer: false,
      reason:
        "You're already inside an attached Yaver. Attaching again would nest a third copy " +
        "with no way back — switch to the host app to change Attach Mode.",
    };
  }
  return { mayOffer: true };
}
