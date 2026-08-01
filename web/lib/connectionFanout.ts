/**
 * connectionFanout.ts — decide WHICH machines a surface opens connections to,
 * and in what order.
 *
 * Yaver's clients used to hold exactly one connection: web kept a single
 * `connectedDevice`, mobile a single connectionManager. Everything you were not
 * looking at showed a Convex heartbeat rather than a verified path, which is
 * why a device card could truthfully read "Alive · last agent signal 55s ago"
 * while the box was unreachable — the two sentences measure different things,
 * and only one of them had been checked.
 *
 * The product decision (2026-08-01) is fan-out BY DEFAULT: connect to as many
 * machines as the account has, so redundancy is real and any of them can serve.
 * A user who wants the old behaviour downgrades to "single".
 *
 * ── On metering, stated plainly ──────────────────────────────────────────────
 *
 * The free relay meters 1500 MB/day per account, and an overage has already
 * cost a real outage (a 3.5 MB × 2s poll burned the cap and a phone lost its
 * only path). Fan-out multiplies that budget by device count, so the policy has
 * to be honest about who pays:
 *
 *   - the OWNER is unmetered (relay tier "owner-dev" → SetDeviceTier
 *     unmetered), so fan-out is uncapped there and the default is free;
 *   - everyone else fans out to a bounded number of machines, ordered so the
 *     ones that matter are connected first, and can opt into "all" explicitly.
 *
 * A cap that silently drops machines would be its own lie, so the plan always
 * reports what it deferred and why — see FanoutPlan.deferred.
 *
 * ── Convex cost is unchanged by fan-out ──────────────────────────────────────
 *
 * Fanning out must not become a Convex bill. It does not: the machine list and
 * the seeded roles already arrive in the ONE /settings + devices read a surface
 * performs at load, and this module adds no call of its own — it is pure, and
 * takes what the surface already has.
 *
 * Connections themselves go to AGENTS (relay or direct), never through Convex,
 * so widening the fan-out multiplies relay bytes and nothing else. Sharing
 * probe results BETWEEN surfaces via Convex was considered and rejected for the
 * same reason: it would turn a read-once model into per-probe writes. Surfaces
 * cache their own results locally instead.
 *
 * ── Ordering is the primary/secondary rule ───────────────────────────────────
 *
 * The seeded roles in Convex (userSettings.machineRolesByProject: runner +
 * secondaryRunner, render + secondaryRender) are not decoration. They are the
 * order. Vibing previously resolved its renderer as
 * `renderDeviceId || runnerDeviceId || whatever-you-last-opened`, which is how
 * a box the account considered neither primary nor secondary ended up selected
 * as RENDER while the healthy primary sat idle.
 */

/** How many machines a surface connects to. */
export type FanoutMode = "all" | "single";

/** Why a machine is in the plan — surfaces render this, so it must be honest. */
export type FanoutRole =
  | "primary-runner"
  | "secondary-runner"
  | "primary-render"
  | "secondary-render"
  | "additional";

export type FanoutCandidate = {
  deviceId: string;
  name?: string;
  /** Convex's view. Never treated as reachability — that is the whole point. */
  isOnline?: boolean;
};

export type FanoutSeed = {
  runnerDeviceId?: string | null;
  secondaryRunnerDeviceId?: string | null;
  renderDeviceId?: string | null;
  secondaryRenderDeviceId?: string | null;
};

export type FanoutTarget = {
  deviceId: string;
  role: FanoutRole;
  /** Lower connects first. Stable across renders so the UI does not churn. */
  order: number;
};

export type FanoutPlan = {
  targets: FanoutTarget[];
  /** Machines intentionally not connected, with the reason. Never silent. */
  deferred: Array<{ deviceId: string; reason: string }>;
  mode: FanoutMode;
  unmetered: boolean;
};

/** Bound for a metered (non-owner) account fanning out on the default setting.
 *  Four covers primary+secondary for both roles — the machines the seeded
 *  config says are load-bearing — without turning a six-device account into a
 *  six-times bandwidth bill. */
export const METERED_FANOUT_LIMIT = 4;

/**
 * planConnectionFanout returns the machines to connect, in order.
 *
 * Pure: same inputs, same plan, no clock and no network. Every surface (web,
 * mobile, tvOS, watch, Wear, car, AR/VR) calls this so the answer cannot differ
 * by screen — a user who sees three machines connected in the browser and one
 * on their phone learns that Yaver's behaviour depends on which device they
 * picked up.
 */
export function planConnectionFanout(input: {
  devices: FanoutCandidate[];
  seed?: FanoutSeed | null;
  mode?: FanoutMode;
  /** Owner accounts are unmetered on the relay, so fan-out is uncapped. */
  isOwner?: boolean;
}): FanoutPlan {
  const mode: FanoutMode = input.mode === "single" ? "single" : "all";
  const unmetered = Boolean(input.isOwner);
  const seed = input.seed || {};

  const known = new Map<string, FanoutCandidate>();
  for (const d of input.devices || []) {
    if (d && typeof d.deviceId === "string" && d.deviceId) known.set(d.deviceId, d);
  }

  // Seeded roles first, in the order the account declared them. A seed that
  // names a device we do not know about is skipped rather than invented —
  // pointing a surface at a deviceId that is not in the list is how you get a
  // spinner with nothing behind it.
  const ordered: FanoutTarget[] = [];
  const claimed = new Set<string>();
  const claim = (id: string | null | undefined, role: FanoutRole) => {
    const key = (id || "").trim();
    if (!key || claimed.has(key) || !known.has(key)) return;
    claimed.add(key);
    ordered.push({ deviceId: key, role, order: ordered.length });
  };

  claim(seed.runnerDeviceId, "primary-runner");
  claim(seed.renderDeviceId, "primary-render");
  claim(seed.secondaryRunnerDeviceId, "secondary-runner");
  claim(seed.secondaryRenderDeviceId, "secondary-render");

  // Then everything else, so redundancy is real rather than aspirational.
  // Stable order: Convex-online first (a better first guess), then by id, so
  // the list does not reshuffle under the user between renders.
  const rest = [...known.values()]
    .filter((d) => !claimed.has(d.deviceId))
    .sort((a, b) => {
      if (Boolean(b.isOnline) !== Boolean(a.isOnline)) return Boolean(b.isOnline) ? 1 : -1;
      return a.deviceId.localeCompare(b.deviceId);
    });
  for (const d of rest) claim(d.deviceId, "additional");

  const deferred: FanoutPlan["deferred"] = [];
  let targets = ordered;

  if (mode === "single") {
    targets = ordered.slice(0, 1);
    for (const t of ordered.slice(1)) {
      deferred.push({ deviceId: t.deviceId, reason: "single-connection mode is on (change it in settings)" });
    }
  } else if (!unmetered && ordered.length > METERED_FANOUT_LIMIT) {
    targets = ordered.slice(0, METERED_FANOUT_LIMIT);
    for (const t of ordered.slice(METERED_FANOUT_LIMIT)) {
      deferred.push({
        deviceId: t.deviceId,
        reason: `free relay is metered (1500 MB/day) — connecting the ${METERED_FANOUT_LIMIT} machines your roles name first`,
      });
    }
  }

  return { targets, deferred, mode, unmetered };
}

/**
 * resolveSeededRole answers "which machine should serve this role", honouring
 * the account's seeded primary and falling back to its seeded secondary before
 * anything else.
 *
 * `isUsable` lets a caller prefer a machine it has actually reached. Passing a
 * predicate that consults verified connectivity is what stops Vibing selecting
 * a renderer that no path can reach while a healthy primary sits idle — the
 * `magara` case on 2026-08-01.
 */
export function resolveSeededRole(
  kind: "runner" | "render",
  seed: FanoutSeed | null | undefined,
  isUsable: (deviceId: string) => boolean = () => true,
): { deviceId: string | null; role: FanoutRole | null; degraded: boolean } {
  const s = seed || {};
  const chain: Array<[string | null | undefined, FanoutRole]> =
    kind === "runner"
      ? [
          [s.runnerDeviceId, "primary-runner"],
          [s.secondaryRunnerDeviceId, "secondary-runner"],
        ]
      : [
          [s.renderDeviceId, "primary-render"],
          [s.secondaryRenderDeviceId, "secondary-render"],
          // A render role with no render seed falls back to the runner box,
          // which is the single-machine setup and not a degradation.
          [s.runnerDeviceId, "primary-runner"],
        ];

  const present = chain.filter(([id]) => Boolean((id || "").trim()));
  for (let i = 0; i < present.length; i++) {
    const [id, role] = present[i];
    const key = (id || "").trim();
    if (isUsable(key)) {
      return { deviceId: key, role, degraded: i > 0 };
    }
  }
  // Nothing usable: return the seeded primary anyway so the surface names the
  // machine the account actually chose, and reports it as unreachable, rather
  // than silently drifting to some other box.
  const first = present[0];
  return first ? { deviceId: (first[0] || "").trim(), role: first[1], degraded: false } : { deviceId: null, role: null, degraded: false };
}
