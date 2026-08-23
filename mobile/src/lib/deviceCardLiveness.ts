export interface DeviceCardPingOutcomeInput {
  reachable: boolean;
  path?: "relay" | "direct";
  elapsedMs: number;
  errorCode?: "relay-credentials-missing" | "no-transport" | "no-transport-configured";
}

export interface DeviceCardPingOutcome {
  ok: boolean;
  headline: string;
  guidance: string;
}

/**
 * One compact, user-facing verdict for a manual machine ping.
 *
 * Heartbeat presence is inventory; this copy is only produced after the
 * phone attempts the real /info operation over every available transport.
 * Keeping it pure makes the offline wording testable without React Native.
 */
export function describeDeviceCardPing(input: DeviceCardPingOutcomeInput): DeviceCardPingOutcome {
  const elapsed = input.elapsedMs < 1000
    ? `${Math.max(1, Math.round(input.elapsedMs))}ms`
    : `${(input.elapsedMs / 1000).toFixed(1)}s`;

  if (input.reachable) {
    return {
      ok: true,
      headline: `Live · ${input.path || "agent"} · ${elapsed}`,
      guidance: "The agent answered. Connecting to Yaver…",
    };
  }

  if (input.errorCode === "relay-credentials-missing") {
    return {
      ok: false,
      headline: `Not live · checked for ${elapsed}`,
      guidance: "The phone is missing relay credentials. Sign in again, then ping this machine.",
    };
  }

  if (input.errorCode === "no-transport-configured") {
    return {
      ok: false,
      headline: `Not live · checked for ${elapsed}`,
      guidance: "No route to this machine is configured. Open Details to review its connection paths.",
    };
  }

  return {
    ok: false,
    headline: `Not live · no response after ${elapsed}`,
    guidance: "Make sure the machine is powered on and Yaver is running, then ping again.",
  };
}
