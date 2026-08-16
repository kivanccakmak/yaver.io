// reconnectLadder.ts — the web reconnect ladder's DECISION seam
// (failure-recovery audit 2026-07, gap T2).
//
// Mobile's ladder (mobile/src/lib/quic.ts scheduleReconnect) has three things
// the web ladder lacked: a relay-repair rung fired once per failure streak, a
// topology-refresh rung every 3rd attempt, and an honest statement at
// give-up. The web AgentClient stopped silently at 8 attempts — the worst UX
// for a box a user only reaches from the dashboard.
//
// Pure function so the policy is testable without timers: given what the
// ladder knows (attempt count, cap, last cause, whether repair already
// fired), return what to do next. AgentClient.scheduleReconnect executes the
// plan verbatim.

import { explainRelayDeny } from "./relayDeny";

export type ReconnectPlan =
  | { action: "stop-terminal"; message: string }
  | { action: "give-up"; message: string }
  | { action: "retry"; repairRelay: boolean; refreshTopology: boolean };

export function planReconnect(input: {
  attempt: number;
  maxAttempts: number;
  lastCause: string | null | undefined;
  repairAttemptedThisStreak: boolean;
}): ReconnectPlan {
  const cause = String(input.lastCause || "");

  // Terminal rung (R3): a deny that no retry can change — device_mismatch —
  // must stop the ladder AND say why, instead of burning the remaining
  // attempts on an impossibility.
  const deny = explainRelayDeny(cause);
  if (deny) return { action: "stop-terminal", message: deny };

  // Named give-up (T2): the ladder used to stop silently at the cap.
  if (input.attempt >= input.maxAttempts) {
    return {
      action: "give-up",
      message:
        `Could not reach the device after ${input.maxAttempts} attempts` +
        (cause ? ` — last error: ${cause}` : "") +
        ". Use Reconnect to try again, or check that the box is online and relay-registered.",
    };
  }

  // Repair rung (mobile parity): relay-auth-shaped cause → repair the relay
  // password once per failure streak. Idempotent + per-user, safe on the
  // shared relay; a no-op for non-auth causes.
  const lower = cause.toLowerCase();
  const relayAuthShaped =
    lower.includes("reason=bad_password") ||
    lower.includes("reason=dead_token") ||
    lower.includes("invalid relay") ||
    lower.includes("relay password");

  // Topology rung (mobile parity): "device not connected to relay" and
  // friends mean the coordinates this ladder was born with are stale —
  // every 3rd attempt, re-pull the relay list + passwords so the next
  // attempt runs against fresh topology.
  const refreshTopology = input.attempt > 0 && input.attempt % 3 === 0;

  return {
    action: "retry",
    repairRelay: relayAuthShaped && !input.repairAttemptedThisStreak,
    refreshTopology,
  };
}
