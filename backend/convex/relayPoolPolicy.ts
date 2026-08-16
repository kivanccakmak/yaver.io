// relayPoolPolicy.ts — PURE shared relay pool policy. No Convex imports, so
// it is unit-testable under `node --experimental-strip-types` (see
// scripts/test-suite.sh policy-test list). relayPool.ts re-exports these for
// the internal actions/mutations that need them.

/**
 * Tenants per shared host.
 *
 * 20 already yields ~96% gross on Relay Pro, so there is no reason to chase
 * the last two points. Oversubscription converts a margin win into an outage,
 * and the relay's scarce resource is BANDWIDTH (Hetzner's ~20 TB/mo
 * allowance), not CPU — a small box has ample CPU for pass-through. Raise this
 * only with measured per-tenant throughput, never optimistically.
 */
export const RELAY_TENANTS_PER_HOST = Number(process.env.YAVER_RELAY_TENANTS_PER_HOST) || 20;

/** Host key for a (region, index) slot. Stable and human-readable in logs. */
export function relayHostKey(region: string, index: number): string {
  const r = String(region || "eu").trim().toLowerCase();
  return `relay-${r}-${Math.max(0, index)}`;
}

export type RelayPoolAssignment = {
  hostKey: string;
  /** True when this tenant is the first on the host, so a box must be created. */
  needsProvision: boolean;
  tenantsOnHost: number;
  reason: string;
};

/**
 * Pure slot selection: first host in the region under capacity, else a new one.
 *
 * Deterministic and side-effect free so the packing rule can be reasoned about
 * (and tested) without touching Convex or a provider.
 */
export function selectRelayHostSlot(args: {
  region: string;
  /** Existing tenant counts, keyed by host. */
  hostCounts: Record<string, number>;
  capacity?: number;
}): RelayPoolAssignment {
  const capacity = args.capacity && args.capacity > 0 ? args.capacity : RELAY_TENANTS_PER_HOST;
  // Deliberately FIRST-FIT, not least-loaded: first-fit keeps hosts densely
  // packed so an idle host can eventually be drained and deleted. Least-loaded
  // spreads tenants evenly and guarantees every host stays half-empty forever,
  // which is the same always-on cost this pool exists to remove.
  for (let i = 0; i < 1000; i++) {
    const key = relayHostKey(args.region, i);
    const count = args.hostCounts[key] ?? 0;
    if (count < capacity) {
      return {
        hostKey: key,
        needsProvision: count === 0,
        tenantsOnHost: count + 1,
        reason: count === 0
          ? `new shared host ${key}`
          : `joined shared host ${key} (${count + 1}/${capacity})`,
      };
    }
  }
  throw new Error(`relay pool exhausted for region ${args.region}`);
}

/**
 * ─── THE deprovision decision — never delete a box other tenants still use ──
 *
 * A shared host serves up to RELAY_TENANTS_PER_HOST tenants from ONE Hetzner
 * box. The pre-2026-08-09 deprovision deleted the box unconditionally, so the
 * FIRST tenant to cancel took the relay offline for everyone else on the host.
 *
 * Rule: mark the departing tenant's row stopped FIRST (so hostIsEmpty no longer
 * counts it), then delete the provider box ONLY when the host is empty. A
 * dedicated relay (no sharedHostKey) is tenant-private and always deletable.
 */
export function sharedHostDeletionDecision(args: {
  sharedHostKey?: string | null;
  /** Live tenant count AFTER this tenant's row has been marked stopped. */
  liveTenantsOnHost: number;
}): { deleteServer: boolean; reason: string } {
  if (!args.sharedHostKey) {
    return { deleteServer: true, reason: "dedicated relay — box is tenant-private" };
  }
  if (args.liveTenantsOnHost <= 0) {
    return { deleteServer: true, reason: "last tenant on shared host — drain and delete the box" };
  }
  return {
    deleteServer: false,
    reason: `${args.liveTenantsOnHost} tenant(s) still on shared host — box must stay`,
  };
}

/**
 * Should deprovision take a grace snapshot before deleting the box?
 *
 * DEDICATED relays: YES — the box is tenant-private, so a resubscribe can be
 * restored from the snapshot.
 *
 * SHARED pool hosts: NO — the host is pass-through (no tenant data worth
 * restoring), and a drained host's snapshot is a billed orphan with no restore
 * path. Measured 2026-08-09: a 0.39 GB `yaver-predelete-relay-*` snapshot was
 * left billed on the owner's account by a shared-host teardown and had to be
 * deleted by hand.
 */
export function sharedHostGraceSnapshotDecision(sharedHostKey?: string | null): boolean {
  return !sharedHostKey;
}
