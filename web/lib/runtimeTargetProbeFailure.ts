// runtimeTargetProbeFailure.ts — shared policy for remote-runtime target probe
// failures. Keep this out of RuntimeLabView so relay-presence routing is not
// an inline regex that every surface has to rediscover.

import { isRelayCredentialDenyMessage } from "./relayAuth";

export type RuntimeTargetProbeFailureKind =
  | "relay-auth"
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

/** Stable code the agent returns when a named project is not on that box.
 *  Mirrors ReasonProjectNotOnThisMachine in
 *  desktop/agent/project_missing_reply.go — keep the two in step. */
export const PROJECT_NOT_ON_THIS_MACHINE_CODE = "project_not_on_this_machine";

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
  // one-tap answer. CORRECTED 2026-08-02: an earlier version of this comment
  // said the picker "merges every machine's projects by NAME". That was carried
  // from a stale note and is wrong — there is no cross-device aggregation
  // anywhere (RuntimeLabView.tsx:1355 and VibeCodingView.tsx:804 both call
  // agentClient.listProjects(), a single connection to the CONNECTED box).
  // The real shape: the list is read from the connected/runner box while the
  // probe targets the render box, so the render box is answering about a list
  // it never supplied. Hence useRunnerFallback: true — rendering where the list
  // came from is the actual fix, not a workaround. See
  // web/lib/projectMachineMismatch.ts, which states it from the device ids.
  //
  // retry: false on purpose. Re-probing cannot conjure a directory; a Retry
  // button here would be a false hope, and offering one is its own small lie.
  if (
    // CODE FIRST. The agent now returns `project_not_on_this_machine` with the
    // available projects (desktop/agent/project_missing_reply.go). Keying off
    // the code means the sentence can be reworded — it already has been twice —
    // without every surface's regex drifting, which is exactly how mobile ended
    // up with three different relay-auth matchers, none a superset of the rest.
    lower.includes(PROJECT_NOT_ON_THIS_MACHINE_CODE) ||
    // Prose fallback for agents older than this change. Kept deliberately: a
    // box that has not updated must still get the deterministic route rather
    // than being escalated to a coding agent.
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
