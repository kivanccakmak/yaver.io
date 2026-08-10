// taskPlacementPolicy.ts — PURE owned-device placement policy. No Convex
// imports, so it is unit-testable under `node --experimental-strip-types`
// (see scripts/test-suite.sh policy-test list). taskPlacement.ts re-exports
// these for the decision layer that needs them.
//
// THE INCIDENT THIS FILE EXISTS FOR (2026-08-10, medici task on
// ubuntu-4gb-hel1-1): the web dashboard created a task while the primary
// self-hosted box's Convex row carried needsAuth=true from an earlier
// relay-password flap. The old owned-candidate filter was
//   devices.filter(d => d.isOnline && !d.needsAuth)
// so the primary was EXCLUDED, the owned pool came back EMPTY, and placement
// fell through to cloud_standard on a managed box that was ASLEEP — which
// cloudMachineEligibleForPlacement happily included because it was "paused".
// The task sat queued with attempts=0 forever ("Cloud workspace · Queue after
// current run · LIVE OUTPUT LOST") while the healthy owned box sat idle.
//
// The rule, in one testable place: LIVE means HEARTBEAT-FRESH, not
// flag-true. A fresh heartbeat proves the agent is alive; a needsAuth flag
// means it needs a re-auth, which is recoverable and strictly better than a
// machine that is asleep. Probe the operation, not the inventory.
//
// HEARTBEAT_STALE_MS mirrors devices.ts:121 — the pure policy cannot import
// the Convex module, so the value lives in both places with the same
// sync-mandate comment. Changing one without the other is a drift bug.

/** How old a lastHeartbeat may be for the box to count as a live candidate. */
export const PLACEMENT_HEARTBEAT_STALE_MS = 900 * 1000;

export type OwnedDeviceCandidate = {
  deviceId?: string;
  isOnline?: boolean;
  lastHeartbeat?: number;
  needsAuth?: boolean;
  installedRunnerIds?: string[];
  publishCapabilities?: string[];
};

export type SelectLiveOwnedOpts = {
  /** Wall clock now, injected so tests can simulate age. */
  now: number;
  targetDeviceId?: string;
  runnerId?: string;
  needsBuild: boolean;
  primaryDeviceId?: string | null;
  secondaryDeviceId?: string | null;
};

/**
 * Order owned devices so the user's explicit primary/secondary come first.
 * Mirrors taskPlacement.orderOwnedDeviceCandidates; duplicated here (pure)
 * so the selection rule is testable without the Convex ctx.
 */
function orderOwned(devices: OwnedDeviceCandidate[], opts: SelectLiveOwnedOpts): OwnedDeviceCandidate[] {
  const out: OwnedDeviceCandidate[] = [];
  const pushById = (id?: string | null) => {
    if (!id) return;
    const found = devices.find((d) => d.deviceId === id);
    if (found && !out.includes(found)) out.push(found);
  };
  pushById(opts.primaryDeviceId);
  pushById(opts.secondaryDeviceId);
  for (const device of devices) {
    if (!out.includes(device)) out.push(device);
  }
  return out;
}

/**
 * The ONE placement question for owned devices: which row is the live
 * candidate for this task? LIVE means heartbeat-fresh — NOT isOnline-flag
 * and NOT needsAuth-cleared. A needsAuth box with a fresh heartbeat is a
 * re-auth away from working; an asleep cloud box is minutes away and may
 * fail to wake at all. Owned-first is the whole point: never fall to cloud
 * while a live owned box exists.
 *
 * Returns the winning deviceId, or null when no owned row is live.
 */
export function selectLiveOwnedDevice(
  devices: OwnedDeviceCandidate[],
  opts: SelectLiveOwnedOpts,
): { deviceId: string } | null {
  const live = devices.filter((d) => {
    if (!d.isOnline) return false;
    const age = opts.now - (d.lastHeartbeat || 0);
    return age < PLACEMENT_HEARTBEAT_STALE_MS;
  });
  const selected = opts.targetDeviceId
    ? live.find((d) => d.deviceId === opts.targetDeviceId)
    : undefined;
  const pool = selected ? [selected] : orderOwned(live, opts);
  const hit = pool.find((d) => {
    if (opts.runnerId && Array.isArray(d.installedRunnerIds) && !d.installedRunnerIds.includes(opts.runnerId)) {
      return false;
    }
    if (!opts.needsBuild) return true;
    return Array.isArray(d.publishCapabilities) && d.publishCapabilities.length > 0;
  });
  return hit?.deviceId ? { deviceId: hit.deviceId } : null;
}
