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
// The rule, in one testable place (mirrored bit-for-bit in
// backend/convex/aliasShadowing.ts — the server runs the same collapse over
// the merged rows it returns; a fix in one is not a fix):
//   • no strong identity conflict → same physical machine seen twice
//     (re-pair, LAN + VPN registration, stale row after a wipe) → MERGE.
//   • strong conflict (different hardwareId or publicKey — genuinely two
//     machines) with exactly one live and one dead (needs-auth + offline)
//     → keep the live one.
//   • strong conflict with BOTH viable → KEEP BOTH rows. Never merge two
//     different machines: that is the flip-flop.

export type AliasPeer = {
  hardwareId?: string | null;
  publicKey?: string | null;
  online: boolean;
  needsAuth: boolean;
};

export type AliasCollisionOutcome = "merge" | "keep-a" | "keep-b" | "keep-both";

export function aliasCollisionOutcome(a: AliasPeer, b: AliasPeer): AliasCollisionOutcome {
  const strongConflict =
    (!!a.hardwareId && !!b.hardwareId && a.hardwareId !== b.hardwareId) ||
    (!!a.publicKey && !!b.publicKey && a.publicKey !== b.publicKey);
  if (!strongConflict) return "merge";
  const aDead = a.needsAuth && !a.online;
  const bDead = b.needsAuth && !b.online;
  const aLive = !a.needsAuth && a.online;
  const bLive = !b.needsAuth && b.online;
  if (aDead && bLive) return "keep-b";
  if (bDead && aLive) return "keep-a";
  return "keep-both";
}
