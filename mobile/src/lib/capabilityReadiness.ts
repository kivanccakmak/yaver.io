// capabilityReadiness.ts — CLASSIFY a capability refusal by its CODE, never by
// its prose.
//
// MOBILE TWIN. Byte-identical to web/lib/capabilityReadiness.ts below this
// header, pinned by capabilityReadiness.test.ts. See that file for why the
// classifier exists: /capabilities/snapshot has always sent `reasonCode`, both
// clients already parsed it into their types, and neither ever switched on it —
// so a permanent platform fact and a momentary outage were rendered with the
// same Retry button.

/** Mirrors desktop/agent/reason_codes.go. */
export const CONNECTIVITY_NO_VIABLE_TRANSPORT = "connectivity.no_viable_transport";
export const DEPLOY_TESTFLIGHT_XCODE_MISSING = "deploy.testflight.xcode_missing";
export const DEPLOY_PLAY_ANDROID_SDK_MISSING = "deploy.play.android_sdk_missing";

export type ReadinessKind =
  /** A settled fact about this machine. Retrying cannot change it. */
  | "platform-constraint"
  /** Something is missing but installable/obtainable here. */
  | "fixable"
  /** True right now and may not be in a moment — a retry is honest. */
  | "transient"
  /** The agent named a code this build does not know. */
  | "unknown";

export type ReadinessVerdict = {
  kind: ReadinessKind;
  /** A short label for the state. NOT a replacement for the agent's `reason`. */
  title: string;
  /** False when a Retry/Try-again affordance must NOT be offered. */
  retryable: boolean;
};

/**
 * Classify an unavailable capability target.
 *
 * `enabled: true` returns null — there is nothing to explain, and a caller that
 * renders a verdict for a healthy target is the "show the inventory, not the
 * answer" clutter LESS IS MORE forbids.
 */
export function classifyReadiness(
  target: { enabled?: boolean; reasonCode?: string } | null | undefined,
): ReadinessVerdict | null {
  if (!target || target.enabled) return null;
  const code = (target.reasonCode || "").trim();

  switch (code) {
    case CONNECTIVITY_NO_VIABLE_TRANSPORT:
      // LAN, relay, tunnel and Tailscale are all down at this instant. That
      // genuinely changes on its own, so a retry is the honest affordance.
      return { kind: "transient", title: "No reachable preview transport", retryable: true };

    case DEPLOY_TESTFLIGHT_XCODE_MISSING:
      // Xcode exists only on macOS. On Linux this can never become true, and
      // offering Retry teaches the user the product does not know its own limits.
      return { kind: "platform-constraint", title: "Xcode is not available on this machine", retryable: false };

    case DEPLOY_PLAY_ANDROID_SDK_MISSING:
      // The Android SDK IS installable on every platform Yaver runs on, so this
      // is a missing thing rather than a settled limit.
      return { kind: "fixable", title: "The Android SDK is not installed", retryable: false };
  }

  // The dynamic families the agent composes per target.
  if (/^capability\..+\.doctor_failed$/.test(code)) {
    return { kind: "fixable", title: "This target's preflight failed", retryable: true };
  }
  if (code === "capability.mobile-hermes.not_ready") {
    return { kind: "fixable", title: "The Hermes lane is not ready", retryable: true };
  }

  // An unknown code from a NEWER agent must not be silently dropped: the target
  // is still unavailable, and saying so with an honest "unknown" beats rendering
  // nothing. Not retryable, because we cannot know that it would help.
  if (code) {
    return { kind: "unknown", title: "Unavailable for a reason this app does not recognise", retryable: false };
  }
  // Old agent, no code at all. The caller falls back to `reason` prose.
  return null;
}

/** True when the surface must NOT offer a retry for this target. */
export function readinessSuppressesRetry(
  target: { enabled?: boolean; reasonCode?: string } | null | undefined,
): boolean {
  const v = classifyReadiness(target);
  return v !== null && !v.retryable;
}
