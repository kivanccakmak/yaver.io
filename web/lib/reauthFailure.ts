// reauthFailure.ts — the sentence a user gets when re-auth/reclaim fails.
//
// What shipped before, on TWO surfaces with two hand-copied formatters
// (app/dashboard/page.tsx and components/dashboard/DevicesView.tsx):
//
//   Re-auth failed: all transports failed. relay · public-free/direct:
//   device not connected to relay
//
// Every token in that string is either a lane label the user cannot act on or
// an internal step name. It also states the *last* thing that failed instead of
// the reason the attempt was impossible: on 2026-07-28 the row's identity had
// been taken over by a SECOND agent on the same box (a circuit-sim cell on
// 127.0.0.1:18090, no relay tunnel), so the relay correctly answered
// `relay.device_not_connected` for a deviceId it has never had a tunnel for.
// Re-auth over the relay could not have worked at any point, on any retry.
//
// This module maps the structured signal that already exists
// (`connectivity.relay.device_not_connected`, classified by
// runtimeTargetProbeFailure.ts) onto a sentence that names the situation and
// the next step, using facts read off the ROW — never hardcoded.
//
// Rules for anything added here:
//   • Name the cause, not the lane. "relay · public-free/direct" is debugging
//     output; keep it behind `technical` for the details view.
//   • Always end with a next step the user can actually take.
//   • Derive specifics (alias, port, version) from the device row.

import {
  classifyRuntimeTargetProbeFailure,
  type RuntimeTargetProbeFailureKind,
} from "@/lib/runtimeTargetProbeFailure";
import type { SecondaryAgentRef } from "@/lib/deviceIdentityMerge";

export type ReauthDiagnostic = {
  path?: string;
  step?: string;
  ok?: boolean;
  error?: string;
};

export type ReauthFailureInput = {
  error?: string | null;
  diagnostics?: ReauthDiagnostic[] | null;
};

export type ReauthTargetDevice = {
  name?: string;
  alias?: string;
  /** Instances collapsed into this row — see lib/deviceIdentityMerge.ts. */
  secondaryAgents?: SecondaryAgentRef[];
};

export type ReauthFailureExplanation = {
  kind: RuntimeTargetProbeFailureKind;
  /** The sentence to render. Plain language, ends with a next step. */
  message: string;
  /** Lane/step dump — for a details row, never the headline. */
  technical: string;
  /** True when retrying cannot help: the transport does not exist. */
  terminal: boolean;
};

function describeInstance(ref: SecondaryAgentRef): string {
  const bits: string[] = [];
  if (ref.alias) bits.push(`@${ref.alias}`);
  if (typeof ref.port === "number" && ref.port > 0) bits.push(`port ${ref.port}`);
  if (ref.agentVersion) bits.push(ref.agentVersion);
  if (bits.length === 0) bits.push(ref.deviceId.slice(0, 8));
  return bits.join(", ");
}

export function formatReauthFailure(
  result: ReauthFailureInput,
  device: ReauthTargetDevice = {},
): ReauthFailureExplanation {
  const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
  const technical = diagnostics
    .map((d) => `${d.path || "?"}/${d.step || "?"}: ${d.ok ? "ok" : d.error || "fail"}`)
    .join(" · ");

  // The relay's own reasonCode arrives on either channel depending on which leg
  // gave up first, so classify over both rather than picking one and inventing
  // a regex for the other (mobile already carries three such regexes).
  const haystack = [result.error || "", ...diagnostics.map((d) => d.error || "")].join(" ");
  const plan = classifyRuntimeTargetProbeFailure(haystack);

  const label = device.alias ? `@${device.alias}` : device.name || "this machine";

  if (plan.kind === "relay-presence" || plan.kind === "relay-route") {
    const others = device.secondaryAgents || [];
    const tunnelless = others.filter((o) => !o.hasTransport);
    if (others.length > 0) {
      const named = (tunnelless.length > 0 ? tunnelless : others).map(describeInstance).join("; ");
      return {
        kind: plan.kind,
        message:
          `${label} runs more than one Yaver agent (also: ${named}). ` +
          `Re-auth can only travel over the relay, and the relay has no tunnel for the instance this row points at. ` +
          `Run \`yaver auth\` on the box (or stop the extra agent), then refresh — or forget this row.`,
        technical,
        terminal: true,
      };
    }
    return {
      kind: plan.kind,
      message:
        `${label} is not connected to the relay, and re-auth from a browser can only travel over the relay. ` +
        `Run \`yaver auth\` on the box itself (or \`yaver serve\` if the agent is down), then refresh.`,
      technical,
      terminal: true,
    };
  }

  if (plan.kind === "agent-verb-skew") {
    return {
      kind: plan.kind,
      message:
        `${label} is running an agent that predates this request. ` +
        `Update it with \`npm install -g yaver-cli@latest\` on the box, then try again.`,
      technical,
      terminal: true,
    };
  }

  const detail = (result.error || "").trim();
  return {
    kind: "other",
    message: detail ? `Re-auth failed: ${detail}` : "Re-auth failed.",
    technical,
    terminal: false,
  };
}

/** One-line form for the compact sidebar/rescue rows. */
export function reauthFailureLine(
  result: ReauthFailureInput,
  device: ReauthTargetDevice = {},
): string {
  return formatReauthFailure(result, device).message;
}
