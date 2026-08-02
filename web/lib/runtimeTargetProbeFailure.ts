// runtimeTargetProbeFailure.ts — shared policy for remote-runtime target probe
// failures. Keep this out of RuntimeLabView so relay-presence routing is not
// an inline regex that every surface has to rediscover.

export type RuntimeTargetProbeFailureKind =
  | "auth"
  | "relay-presence"
  | "relay-route"
  | "agent-verb-skew"
  | "project-missing"
  | "other";

export type RuntimeTargetProbeFailurePlan = {
  kind: RuntimeTargetProbeFailureKind;
  retry: boolean;
  useRunnerFallback: boolean;
  showFixWithRunner: boolean;
};

export const RELAY_DEVICE_NOT_CONNECTED_CODE = "relay.device_not_connected";
export const RELAY_DEVICE_NOT_CONNECTED_REASON = "connectivity.relay.device_not_connected";

function isRelayCredentialFailure(lower: string): boolean {
  return (
    lower.includes("relay_password_missing") ||
    lower.includes("relay_password_invalid") ||
    lower.includes("relay_password_rate_limited") ||
    lower.includes("relay password missing") ||
    lower.includes("invalid relay password") ||
    lower.includes("relay password mismatch") ||
    lower.includes("too many invalid relay password attempts") ||
    lower.includes("reason=bad_password") ||
    lower.includes("relay authentication failed")
  );
}

export function classifyRuntimeTargetProbeFailure(error: string | null | undefined): RuntimeTargetProbeFailurePlan {
  const raw = String(error || "");
  const lower = raw.toLowerCase();

  if (isRelayCredentialFailure(lower)) {
    return {
      kind: "auth",
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

  // THE PROJECT IS SIMPLY NOT ON THE RENDER BOX (2026-08-02).
  //
  // The agent answers, truthfully and instantly:
  //     no mobile project named "yaver / mobile" on this machine
  //       — check `yaver projects mobile`
  // (desktop/agent/devserver_http.go). Before this branch that landed in
  // `other`, so the dashboard offered "Fix with <runner>" and a real LLM run
  // was spent on a question a directory listing answers. The runner then edited
  // the WRONG machine's tree, because the project it was asked about lives on
  // the other box.
  //
  // This is deterministic, and under a runner/render split it usually has a
  // one-tap answer: the project the user picked exists on the RUNNER box (the
  // picker merges every machine's projects by NAME, so it offered a project the
  // render box never had). Hence useRunnerFallback: true — rendering on the
  // runner box is the actual fix, not a workaround.
  //
  // retry: false on purpose. Re-probing cannot conjure a directory; a Retry
  // button here would be a false hope, and offering one is its own small lie.
  if (
    lower.includes("on this machine — check") ||
    lower.includes("on this machine - check") ||
    (lower.includes("no mobile project named") && lower.includes("on this machine")) ||
    (lower.includes("project") && lower.includes("not found on") && lower.includes("machine"))
  ) {
    return {
      kind: "project-missing",
      retry: false,
      useRunnerFallback: true,
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
