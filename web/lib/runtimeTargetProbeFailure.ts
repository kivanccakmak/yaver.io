// runtimeTargetProbeFailure.ts — shared policy for remote-runtime target probe
// failures. Keep this out of RuntimeLabView so relay-presence routing is not
// an inline regex that every surface has to rediscover.

import { isRelayCredentialDenyMessage } from "./relayAuth";

export type RuntimeTargetProbeFailureKind =
  | "relay-auth"
  | "relay-presence"
  | "relay-route"
  | "agent-verb-skew"
  | "other";

export type RuntimeTargetProbeFailurePlan = {
  kind: RuntimeTargetProbeFailureKind;
  retry: boolean;
  useRunnerFallback: boolean;
  showFixWithRunner: boolean;
};

export const RELAY_DEVICE_NOT_CONNECTED_CODE = "relay.device_not_connected";
export const RELAY_DEVICE_NOT_CONNECTED_REASON = "connectivity.relay.device_not_connected";

export function classifyRuntimeTargetProbeFailure(error: string | null | undefined): RuntimeTargetProbeFailurePlan {
  const raw = String(error || "");
  const lower = raw.toLowerCase();

  // The relay refused THIS browser's account relay password before the request
  // reached the render machine. That is a deterministic credential refresh,
  // never a coding task: routing this to "Fix with runner" just asks an LLM on
  // a box it cannot reach to repair a browser-side relay secret.
  if (isRelayCredentialDenyMessage(raw)) {
    return {
      kind: "relay-auth",
      retry: true,
      useRunnerFallback: false,
      showFixWithRunner: false,
    };
  }

  // An /ops verb the agent has never heard of is VERSION SKEW — the web
  // shipped a call the installed agent predates. Deterministic fix (update
  // the agent), so never route it to a coding runner: an LLM cannot add a
  // verb to a released binary, and one such escalation already burned 121k
  // tokens grepping for the verb name in the wrong repo (2026-07-28).
  if (lower.includes("unknown_verb") || lower.includes("unknown verb")) {
    return {
      kind: "agent-verb-skew",
      retry: true,
      useRunnerFallback: false,
      showFixWithRunner: false,
    };
  }
  const relayPresence =
    lower.includes(RELAY_DEVICE_NOT_CONNECTED_CODE) ||
    lower.includes(RELAY_DEVICE_NOT_CONNECTED_REASON) ||
    lower.includes("device not connected to relay");
  if (relayPresence) {
    return {
      kind: "relay-presence",
      retry: true,
      useRunnerFallback: true,
      showFixWithRunner: false,
    };
  }

  if (lower.includes("only reachable over a relay")) {
    return {
      kind: "relay-route",
      retry: true,
      useRunnerFallback: true,
      showFixWithRunner: false,
    };
  }

  if (
    lower.includes("render_unreachable") ||
    (lower.includes("render machine") && lower.includes("not reachable")) ||
    (lower.includes("runner/render split") && lower.includes("not reachable"))
  ) {
    return {
      kind: "relay-presence",
      retry: true,
      useRunnerFallback: true,
      showFixWithRunner: false,
    };
  }

  // An unreachable RUNNER is a machine problem too — a coding agent on the
  // dead box cannot fix the dead box. Deterministic routes only, and the
  // render-on-runner fallback is pointless (the runner is the offline one).
  if (lower.includes("runner_unreachable") || (lower.includes("runner machine") && lower.includes("not reachable"))) {
    return {
      kind: "relay-presence",
      retry: true,
      useRunnerFallback: false,
      showFixWithRunner: false,
    };
  }

  return {
    kind: "other",
    retry: false,
    useRunnerFallback: false,
    showFixWithRunner: true,
  };
}
