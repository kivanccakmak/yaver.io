// runtimeTargetProbeFailure.ts — shared policy for remote-runtime target probe
// failures. Keep this out of RuntimeLabView so relay-presence routing is not
// an inline regex that every surface has to rediscover.

export type RuntimeTargetProbeFailureKind =
  | "relay-presence"
  | "relay-route"
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
