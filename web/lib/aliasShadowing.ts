// aliasShadowing.ts — what to do when TWO device rows share one
// platform:hostname alias key.
//
// The 2026-07-26 picker flip-flop: the linux box ran a second `yaver serve`
// (the circuit-sim service cell) whose device row shared the hostname with
// the real agent's row. Both rows were healthy, so pickActiveListedDevice
// returned null and the collapse fell through to a last-heartbeat-wins
// MERGE — deviceId/name flipped on every heartbeat and the phone's picker
// oscillated between two identities.
//
// 2026-07-28 follow-up: this file was written FOR that incident and never
// fired for it. Both agents report the same hardwareId (hwid.go), so the
// IDENTITY stage of the collapse (`hwid:` key) folded them together before the
// ALIAS stage ever ran. The fix is two-part: the identity merge is now
// health-first (deviceIdentityMerge.ts), and the case gets a NAME here —
// same box, distinct running agent instances — so no stage can mistake it for
// two machines or for one machine seen twice.
//
// The rule, in one testable place (mirrored bit-for-bit in
// backend/convex/aliasShadowing.ts and mobile/src/lib/aliasShadowing.ts — every surface
// runs the same collapse over its own snapshot; a fix in one is not a fix):
//   • no strong identity conflict → same physical machine seen twice
//     (re-pair, LAN + VPN registration, stale row after a wipe) → MERGE.
//   • same hardwareId but a DIFFERENT publicKey/port/deviceId, and both rows
//     heartbeating right now → two agent instances on ONE box →
//     MERGE-SECONDARY. Health picks the identity, the loser is recorded as a
//     secondary agent, and it never owns the row. Splitting these into two
//     rows (the old `keep-both`) is wrong: there is one machine.
//   • strong conflict (different hardwareId, or different publicKey on rows
//     that do not share a hardwareId — genuinely two machines) with exactly
//     one live and one dead (needs-auth + offline) → keep the live one.
//   • strong conflict with BOTH viable → KEEP BOTH rows. Never merge two
//     different machines: that is the flip-flop.

/**
 * How fresh a heartbeat must be to mean "this agent is RUNNING", as opposed to
 * a leftover row from a re-pair or a wipe. Mirrors HEARTBEAT_STALE_MS.
 * Only two rows that are BOTH live can be two agents on one box.
 */
export const AGENT_LIVE_WINDOW_MS = 900 * 1000;

export type AliasPeer = {
  hardwareId?: string | null;
  publicKey?: string | null;
  online: boolean;
  needsAuth: boolean;
  /** Agent endpoint port — 18080 (the real agent) vs 18090 (a service cell). */
  port?: number | null;
  deviceId?: string | null;
  /** ms epoch of the last heartbeat. Tells RUNNING apart from LEFTOVER. */
  lastHeartbeat?: number | null;
};

export type AgentInstanceRelation =
  | "same-agent"
  | "second-agent-same-box"
  | "different-machines";

export function agentInstanceRelation(
  a: AliasPeer,
  b: AliasPeer,
  now: number = Date.now(),
): AgentInstanceRelation {
  const bothHwid = !!a.hardwareId && !!b.hardwareId;
  if (bothHwid && a.hardwareId !== b.hardwareId) return "different-machines";
  const sameBox = bothHwid && a.hardwareId === b.hardwareId;
  // A publicKey conflict only proves "two machines" when nothing else ties the
  // rows to one box. With a shared hardwareId it proves the opposite: two
  // agents, each with its own keypair, on the SAME box.
  if (!sameBox && !!a.publicKey && !!b.publicKey && a.publicKey !== b.publicKey) {
    return "different-machines";
  }
  if (!sameBox) return "same-agent";
  const distinctInstance =
    (!!a.publicKey && !!b.publicKey && a.publicKey !== b.publicKey) ||
    (!!a.port && !!b.port && a.port !== b.port) ||
    (!!a.deviceId && !!b.deviceId && a.deviceId !== b.deviceId);
  if (!distinctInstance) return "same-agent";
  const live = (p: AliasPeer) =>
    typeof p.lastHeartbeat === "number" &&
    p.lastHeartbeat > 0 &&
    now - p.lastHeartbeat < AGENT_LIVE_WINDOW_MS;
  // Only concurrently-heartbeating rows are two RUNNING agents. A stale row is
  // just a duplicate of one agent's history — calling it "a second agent on
  // :18090" would be a fresh lie in place of the old one.
  if (!live(a) || !live(b)) return "same-agent";
  return "second-agent-same-box";
}

export type AliasCollisionOutcome =
  | "merge"
  | "merge-secondary"
  | "keep-a"
  | "keep-b"
  | "keep-both";

export function aliasCollisionOutcome(
  a: AliasPeer,
  b: AliasPeer,
  now: number = Date.now(),
): AliasCollisionOutcome {
  const relation = agentInstanceRelation(a, b, now);
  if (relation === "second-agent-same-box") return "merge-secondary";
  if (relation !== "different-machines") return "merge";
  const aDead = a.needsAuth && !a.online;
  const bDead = b.needsAuth && !b.online;
  const aLive = !a.needsAuth && a.online;
  const bLive = !b.needsAuth && b.online;
  if (aDead && bLive) return "keep-b";
  if (bDead && aLive) return "keep-a";
  return "keep-both";
}
