/**
 * What transports can this PLATFORM actually perform?
 *
 * Not "is the box reachable" — that is a runtime probe. This answers the prior
 * question the code never asked: is this transport *possible here at all*.
 *
 * ── The bug this exists to remove ───────────────────────────────────────────
 *
 * On 2026-07-25 the app ran as RN-web in Chromium and sat on
 * "Transport pending · Agent status unavailable" indefinitely, while the SAME
 * account on a real iPhone showed "Relay · 301ms" and a live coding session.
 * Nothing was broken: the phone connects over the QUIC relay, and a browser
 * cannot speak raw QUIC or send a UDP beacon packet — not "usually fails",
 * CANNOT, at any latency, with any credentials, forever.
 *
 * So the app was waiting on an event that could never arrive, and reported that
 * as "pending" — the same silence-as-diagnosis defect found four times over in
 * one evening. An impossible operation must be stated as impossible, not
 * rendered as a spinner. A user cannot distinguish "still trying" from "will
 * never work", and neither could the code, because nobody had written down what
 * the platform can do.
 *
 * ── Why a capability table rather than scattered Platform.OS checks ─────────
 *
 * `Platform.OS === "web"` sprinkled through the connect path is how the two
 * crashes of the same evening happened (secureStoreCompat, beacon.web). One
 * table, one import, one place to update when a transport is added — and a test
 * that fails if a new transport is introduced without declaring its platform
 * support.
 */

/**
 * Web is detected by the presence of a DOM rather than by importing
 * `Platform` from react-native. Two reasons, both load-bearing:
 *
 *   • it keeps this module importable from a plain `tsx` test — the harness the
 *     rest of src/lib uses ("No RN, no jest") — so the capability contract is
 *     actually verified rather than assumed;
 *   • it cannot drift from reality: a DOM is exactly what makes UDP and raw
 *     QUIC impossible, which is the property this table encodes.
 *
 * On a device there is no `document`, so this is false and every native
 * transport stays enabled — the existing phone channel is untouched.
 */

export type TransportKind = "lan-beacon" | "direct-http" | "quic-relay" | "quic-direct";

export interface TransportCapability {
  kind: TransportKind;
  /** Can this platform perform it AT ALL? Not whether it will succeed now. */
  supported: boolean;
  /** Plain-language reason when unsupported — goes straight into the UI. */
  reason?: string;
}

const isWeb = typeof document !== "undefined";

/**
 * Browsers get exactly one lane: plain HTTP to the agent.
 *
 * Verified 2026-07-25 against the live agent — it already returns
 * `Access-Control-Allow-Origin: http://localhost:8081` and passes preflight
 * with `Authorization`, so the direct-HTTP lane needs no server-side change.
 * The gap was purely that nothing selected it.
 */
export const TRANSPORT_CAPABILITIES: Record<TransportKind, TransportCapability> = {
  "lan-beacon": {
    kind: "lan-beacon",
    supported: !isWeb,
    reason: isWeb ? "Browsers cannot send or receive UDP, so LAN discovery is unavailable here." : undefined,
  },
  "quic-relay": {
    kind: "quic-relay",
    supported: !isWeb,
    reason: isWeb ? "Browsers cannot open a raw QUIC connection to the relay." : undefined,
  },
  "quic-direct": {
    kind: "quic-direct",
    supported: !isWeb,
    reason: isWeb ? "Browsers cannot open a raw QUIC connection to the machine." : undefined,
  },
  "direct-http": {
    kind: "direct-http",
    supported: true,
    reason: undefined,
  },
};

export function canUseTransport(kind: TransportKind): boolean {
  return TRANSPORT_CAPABILITIES[kind].supported;
}

export function usableTransports(): TransportKind[] {
  return (Object.keys(TRANSPORT_CAPABILITIES) as TransportKind[]).filter(canUseTransport);
}

/**
 * The sentence to show INSTEAD of a spinner when the only lanes this platform
 * could use are ruled out. Returns null when something is still worth waiting
 * for — the caller may keep spinning only in that case.
 */
export function explainNoTransport(attempted: TransportKind[]): string | null {
  const possible = attempted.filter(canUseTransport);
  if (possible.length > 0) return null;
  const reasons = attempted
    .map((k) => TRANSPORT_CAPABILITIES[k].reason)
    .filter((r): r is string => !!r);
  const unique = [...new Set(reasons)];
  return (
    `No connection method available on this platform. ${unique.join(" ")} ` +
    `Reach the machine over direct HTTP (same network, or a reachable address) to use it from a browser.`
  );
}

/** True when running somewhere with the full native transport set. */
export const hasNativeTransports = !isWeb;
