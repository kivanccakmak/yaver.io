// deviceIdentityMerge.ts — WHO owns the merged device row.
//
// One physical box can run more than one `yaver serve`. They report the SAME
// hardwareId (desktop/agent/hwid.go), so the listing collapse folds them into
// one row — and whichever row wins that fold donates its `deviceId`,
// `needsAuth`, `quicPort`, agent version and runner set to everything the user
// then clicks.
//
// The 2026-07-28 incident, verbatim: `ubuntu-4gb-hel1-1` ran the healthy agent
// (v1.99.389, port 18080, relay tunnel up) AND a circuit-sim service cell
// (v1.99.259, bound to 127.0.0.1:18090 — loopback only, no relay tunnel,
// needsAuth). The old winner rule was an `||` chain in which RECENCY beat
// HEALTH:
//
//     const incomingWins =
//       (!!a.needsAuth && !b.needsAuth) ||
//       (b.lastHeartbeat || 0) > (a.lastHeartbeat || 0) ||   // <— this
//       (!!b.isOnline && !a.isOnline);
//
// so any cycle in which the loopback cell heartbeated one second later handed
// it the merged identity. The card showed the healthy box's name and "online",
// carried `needsAuth: true`, and every action — RECLAIM, connect, recycle,
// power — routed to a deviceId with no relay tunnel. RECLAIM POSTed to
// `<relay>/d/<loopback-id>/auth/recover`, the relay had no tunnel for that
// exact id (exact-match since 82d8bb805) → 502 `relay.device_not_connected`,
// the LAN lane is skipped on https by design → "all transports failed". Not
// flaky: structurally impossible. And it FLIP-FLOPPED — the button appeared and
// disappeared with heartbeat order.
//
// Three rules, all of them load-bearing:
//   1. HEALTH FIRST. A row that can be authenticated outranks one that says
//      needs-auth, in BOTH directions (the old chain only handled a-broken).
//   2. TRANSPORT EVIDENCE NEXT. A live relay tunnel beats a bare `isOnline`
//      flag beats nothing. Owning the identity means being dialable.
//   3. TOTALLY DETERMINISTIC. Heartbeat is only a tie-break, and deviceId is
//      the final one — a merge whose result depends on argument order is the
//      flip-flop wearing a different hat.
//
// And the collapse must not DESTROY what it folds away: `describeSecondaryAgent`
// keeps the losing instance's deviceId/port/version so a surface can say
// "this box also runs a second agent on :18090" instead of silently pretending
// there is one.
//
// Mirrored, deliberately, from backend/convex/deviceIdentityMerge.ts — web
// collapses the same rows a SECOND time client-side (web/lib/use-devices.ts
// ::mergeDeviceEntries), so a fix in one is not a fix. Both are covered by
// tests that share these fixtures.

// TYPE-ONLY import, kept identical to the Convex twin. The predicate arrives as
// a parameter (`relate`) so this module has no runtime edge to aliasShadowing —
// on the Convex side that keeps the deploy bundle and the unit test agreeing on
// module resolution, and here it keeps the two files byte-comparable.
import type { AliasPeer, AgentInstanceRelation } from "./aliasShadowing";

/**
 * How fresh a heartbeat must be for us to treat the row as a *running* agent.
 * Mirrors HEARTBEAT_STALE_MS in devices.ts / web/lib/use-devices.ts. Used to
 * tell "a second agent is running on this box right now" apart from "a stale
 * row left over from a re-pair or a wipe" — only the former is a real
 * secondary agent worth naming to the user.
 */
export const AGENT_LIVE_WINDOW_MS = 900 * 1000;

export type IdentityCandidate = {
  deviceId: string;
  needsAuth: boolean;
  isOnline: boolean;
  lastHeartbeat: number;
  /** Port the agent's QUIC/HTTP endpoint is on — 18080 vs 18090 tells them apart. */
  port?: number;
  agentVersion?: string;
  alias?: string;
  publicKey?: string | null;
  hardwareId?: string | null;
  relayConnected?: boolean;
  lastTunnelEvent?: { online?: boolean; at?: number } | null;
};

/** A collapsed-away agent instance, kept so the merge does not destroy the truth. */
export type SecondaryAgentRef = {
  deviceId: string;
  port?: number;
  agentVersion?: string;
  alias?: string;
  needsAuth: boolean;
  /** True when this instance has its own evidence of a dialable transport. */
  hasTransport: boolean;
};

/** A relay tunnel event that is both `online` and recent enough to believe. */
export function hasLiveRelayTunnel(c: IdentityCandidate, now: number): boolean {
  if (c.relayConnected === true) return true;
  const ev = c.lastTunnelEvent;
  if (!ev || ev.online !== true) return false;
  const at = typeof ev.at === "number" ? ev.at : 0;
  return at > 0 && now - at < AGENT_LIVE_WINDOW_MS;
}

/**
 * 2 = we have seen a relay tunnel for THIS deviceId; 1 = it heartbeats and
 * claims online; 0 = nothing. Note that 1 is a claim, not a proof — but it
 * still outranks 0, and 2 outranks both because a tunnel is what re-auth and
 * every browser action actually ride on.
 */
export function transportEvidenceScore(c: IdentityCandidate, now: number): 0 | 1 | 2 {
  if (hasLiveRelayTunnel(c, now)) return 2;
  if (c.isOnline) return 1;
  return 0;
}

/** True when the row's heartbeat is fresh enough to mean "an agent is running". */
export function isLiveInstance(c: IdentityCandidate, now: number): boolean {
  return (c.lastHeartbeat || 0) > 0 && now - (c.lastHeartbeat || 0) < AGENT_LIVE_WINDOW_MS;
}

/**
 * Health-first, deterministic. Returns which candidate owns the merged
 * identity. Guaranteed symmetric: pickIdentityOwner(a,b) and
 * pickIdentityOwner(b,a) name the same row.
 */
export function pickIdentityOwner(
  a: IdentityCandidate,
  b: IdentityCandidate,
  now: number = Date.now(),
): "a" | "b" {
  // 1. Health. An agent that needs auth cannot answer an authenticated call,
  //    so it must never own the identity while a signed-in sibling exists.
  const aAuth = a.needsAuth ? 0 : 1;
  const bAuth = b.needsAuth ? 0 : 1;
  if (aAuth !== bAuth) return aAuth > bAuth ? "a" : "b";

  // 2. Transport. Owning the identity means every action routes to you.
  const aT = transportEvidenceScore(a, now);
  const bT = transportEvidenceScore(b, now);
  if (aT !== bT) return aT > bT ? "a" : "b";

  // 3. Recency — a TIE-BREAK, never a trump.
  const aHb = a.lastHeartbeat || 0;
  const bHb = b.lastHeartbeat || 0;
  if (aHb !== bHb) return aHb > bHb ? "a" : "b";

  // 4. Total order. Without this the merge is argument-order dependent, and an
  //    order-dependent merge is exactly the flip-flop we are fixing.
  const aId = String(a.deviceId || "");
  const bId = String(b.deviceId || "");
  if (aId !== bId) return aId < bId ? "a" : "b";
  return "a";
}

/** Project an identity candidate onto the shape aliasShadowing's rule reads. */
export function asAliasPeer(c: IdentityCandidate): AliasPeer {
  return {
    hardwareId: c.hardwareId,
    publicKey: c.publicKey,
    online: c.isOnline,
    needsAuth: c.needsAuth,
    port: c.port,
    deviceId: c.deviceId,
    lastHeartbeat: c.lastHeartbeat,
  };
}

export function describeSecondaryAgent(c: IdentityCandidate, now: number = Date.now()): SecondaryAgentRef {
  return {
    deviceId: c.deviceId,
    port: c.port,
    agentVersion: c.agentVersion,
    alias: c.alias,
    needsAuth: !!c.needsAuth,
    hasTransport: transportEvidenceScore(c, now) > 0,
  };
}

/**
 * Merge two secondary-agent lists, drop any entry that has become the row's own
 * identity, and keep the list bounded and deterministic (sorted by deviceId).
 */
export function mergeSecondaryAgents(
  a: SecondaryAgentRef[] | undefined,
  b: SecondaryAgentRef[] | undefined,
  ownerDeviceId: string,
  extra?: SecondaryAgentRef | null,
): SecondaryAgentRef[] | undefined {
  const byId = new Map<string, SecondaryAgentRef>();
  for (const ref of [...(a || []), ...(b || []), ...(extra ? [extra] : [])]) {
    if (!ref || !ref.deviceId) continue;
    if (ref.deviceId === ownerDeviceId) continue;
    byId.set(ref.deviceId, ref);
  }
  if (byId.size === 0) return undefined;
  return [...byId.values()].sort((x, y) => (x.deviceId < y.deviceId ? -1 : 1));
}

export type IdentityMergeResult<T> = {
  /** Owns the merged identity: deviceId, needsAuth, port, version, runners. */
  base: T;
  /** Collapsed away. Its liveness/IP fields may still be OR'd in by the caller. */
  other: T;
  /** Whether `other` is a genuinely separate RUNNING agent on the same box. */
  secondAgentOnSameBox: boolean;
  secondaryAgents?: SecondaryAgentRef[];
};

/**
 * The one decision both collapses make, over whatever row shape the surface
 * carries. `toCandidate` projects the row onto the fields the rule needs, so
 * Convex's ListedDevice and the web Device can share this function instead of
 * two hand-copied `||` chains that drift (they already did — the web copy did
 * not even have the needsAuth clause).
 */
export type IdentityMergeOptions<T> = {
  /**
   * `agentInstanceRelation` from aliasShadowing.ts. Injected rather than
   * imported so this module has no runtime edge to it (see the type-only
   * import note at the top) — but it is the SAME function every caller passes,
   * so the identity stage and the alias stage cannot disagree about what they
   * are looking at.
   */
  relate: (a: AliasPeer, b: AliasPeer, now: number) => AgentInstanceRelation;
  readSecondaries?: (row: T) => SecondaryAgentRef[] | undefined;
  now?: number;
};

export function resolveIdentityMerge<T>(
  a: T,
  b: T,
  toCandidate: (row: T) => IdentityCandidate,
  opts: IdentityMergeOptions<T>,
): IdentityMergeResult<T> {
  const now = opts.now ?? Date.now();
  const readSecondaries = opts.readSecondaries ?? (() => undefined);
  const ca = toCandidate(a);
  const cb = toCandidate(b);
  const incomingWins = pickIdentityOwner(ca, cb, now) === "b";
  const base = incomingWins ? b : a;
  const other = incomingWins ? a : b;
  const otherCandidate = incomingWins ? ca : cb;

  // Two agents on one box, both heartbeating, distinct instance → a fact worth
  // keeping. A stale duplicate of ONE agent is not a second agent and must not
  // be reported as one: naming a phantom ":18090" would just replace the old
  // lie with a fresh one.
  const secondAgentOnSameBox =
    opts.relate(asAliasPeer(ca), asAliasPeer(cb), now) === "second-agent-same-box";

  return {
    base,
    other,
    secondAgentOnSameBox,
    secondaryAgents: mergeSecondaryAgents(
      readSecondaries(a),
      readSecondaries(b),
      toCandidate(base).deviceId,
      secondAgentOnSameBox ? describeSecondaryAgent(otherCandidate, now) : null,
    ),
  };
}
