// relayDeny.ts — name the relay's verdicts instead of rendering them as
// generic unreachability (failure-recovery audit 2026-07, gaps R3, R13, R14).
//
// The relay states its deny reasons truthfully (`reason=device_mismatch`,
// `reason=dead_token`, "free relay user rate limit exceeded", "bandwidth
// limit exceeded: NMB used of NMB daily limit") — and the clients dropped
// every one of them into a generic "could not reach" or a raw string. Two
// classes fixed here:
//
//  • device_mismatch is the ONE relay-auth failure that can never self-heal
//    (the box belongs to a different account; no retry or repair changes
//    that) — and it was also the one no UI named, so it looped as
//    "Reconnecting (n/5)" forever.
//  • Free-tier / bandwidth verdicts are a monetization boundary rendered as
//    a raw string — no statement that it resets, or that direct/tunnel paths
//    are unmetered.
//
// KEEP IN SYNC with mobile/src/lib/relayDeny.ts (same shapes, same wording —
// relayDeny.test.ts pins the parity) and with relay/server.go's actual
// error strings.

/** Named remedy for a TERMINAL relay deny — one where retrying cannot help.
 *  Returns null for anything a retry/repair rung might still fix. */
export function explainRelayDeny(cause: string | null | undefined): string | null {
  const lower = String(cause || "").toLowerCase();
  if (lower.includes("reason=device_mismatch") || lower.includes("does not own this deviceid")) {
    return (
      "The relay refused this device: it is signed in as a different Yaver account " +
      "than this one (reason=device_mismatch). Retrying can't help — run `yaver auth` " +
      "on the box to sign it into this account, or switch here to the account the box uses."
    );
  }
  return null;
}

export type RelayLimitCard = {
  kind: "free-tier-rate" | "bandwidth-cap" | "rate-limit";
  title: string;
  detail: string;
};

/** Compact named card for relay free-tier / bandwidth limits (R13, R14).
 *  Returns null when the message is not a limit verdict. */
export function classifyRelayLimit(message: string | null | undefined): RelayLimitCard | null {
  const raw = String(message || "");
  const lower = raw.toLowerCase();
  const bw = raw.match(/bandwidth limit exceeded: (\d+)MB used of (\d+)MB daily limit/i);
  if (bw) {
    return {
      kind: "bandwidth-cap",
      title: "Daily relay bandwidth cap reached",
      detail:
        `This device moved ${bw[1]} MB of its ${bw[2]} MB daily relay allowance. ` +
        "The cap resets daily. Direct LAN and tunnel connections are unmetered — " +
        "use one of those, or wait for the reset. A stream that stops mid-way with " +
        "this message was cut by the cap, not by your network.",
    };
  }
  if (lower.includes("free relay user rate limit exceeded")) {
    return {
      kind: "free-tier-rate",
      title: "Relay free-tier rate limit",
      detail:
        "The shared relay is rate-limiting this account's requests. This clears by " +
        "itself within a minute — sustained heavy use is better served by a direct " +
        "LAN or tunnel connection, which is never rate-limited.",
    };
  }
  if (lower.includes("rate limit exceeded")) {
    return {
      kind: "rate-limit",
      title: "Relay rate limit",
      detail:
        "The relay is rate-limiting requests from this network right now. Wait a " +
        "moment and retry; direct LAN and tunnel connections are unaffected.",
    };
  }
  return null;
}
