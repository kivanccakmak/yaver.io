// pressureNotice.ts — turn the agent's `storage_pressure` push into the
// sentence and the destination it already paid for.
//
// The agent sends five facts (storage_pressure.go:65-86): `alerts`,
// `hostname`, `deepLink`, `reclaimable`/`reclaimableBytes`, and
// `usedPct`/`freeGb`. The phone read three of them. `usedPct`/`freeGb` — the
// only numbers that say HOW full — were dropped, so the alert could say "is
// running out of space" without ever stating how much was left. And `deepLink`
// was discarded in favour of a hardcoded push to the device LIST, while the
// call site's own comment promised "tapping through opens the box's Storage
// panel". A destination the producer names and the consumer overrides is the
// same defect as a field nobody reads: the agent's answer was correct and
// unused.
//
// Pure on purpose — routing and Alert live at the call site, the decisions live
// here where a test can reach them (pressureNotice.test.mts).

/** The subset of the push this module needs. Everything is optional because
 *  an older agent may not send it, and a missing figure must degrade to a
 *  quieter sentence rather than to "undefined". */
export type StoragePressurePush = {
  alerts?: unknown;
  hostname?: unknown;
  deepLink?: unknown;
  reclaimable?: unknown;
  usedPct?: unknown;
  freeGb?: unknown;
};

/** In-app routes the agent's deep links map to. `yaver://` cannot be handed to
 *  the OS on iOS — the CarPlay-only scene manifest swallows openURL — so we
 *  resolve the destination in-process instead of round-tripping through the
 *  URL scheme. */
const DEEP_LINK_ROUTES: Record<string, string> = {
  storage: "/storage",
  devices: "/(tabs)/devices",
  tasks: "/(tabs)/tasks",
};

/**
 * Resolve `yaver://<target>` to an in-app route.
 *
 * Falls back to the device list for anything unrecognised: a push from a NEWER
 * agent naming a screen this build does not have must still land somewhere
 * useful rather than silently doing nothing.
 */
export function pressureRoute(deepLink: unknown): string {
  const raw = typeof deepLink === "string" ? deepLink.trim() : "";
  const target = raw.replace(/^yaver:\/\//i, "").replace(/^\/+/, "").split(/[/?#]/)[0].toLowerCase();
  return DEEP_LINK_ROUTES[target] || "/(tabs)/devices";
}

/**
 * The alert body: what is wrong, how full, and what can be recovered.
 *
 * Order matters — the alerts are the agent's own prose and lead; the fullness
 * figure grounds them; the reclaimable figure is what turns the notice from bad
 * news into an offer to act.
 */
export function pressureBody(push: StoragePressurePush): string {
  const alerts: string[] = Array.isArray(push.alerts) ? push.alerts.filter((a): a is string => typeof a === "string") : [];
  const parts: string[] = [];
  if (alerts.length) parts.push(alerts.join("\n"));

  const pct = typeof push.usedPct === "number" ? Math.round(push.usedPct) : null;
  const freeGb = typeof push.freeGb === "number" ? push.freeGb : null;
  if (pct !== null && freeGb !== null) {
    parts.push(`The fullest volume is ${pct}% used — ${freeGb.toFixed(1)} GB free.`);
  } else if (pct !== null) {
    parts.push(`The fullest volume is ${pct}% used.`);
  }

  if (typeof push.reclaimable === "string" && push.reclaimable && push.reclaimable !== "0 B") {
    parts.push(`${push.reclaimable} of build caches can be reclaimed.`);
  }
  return parts.join("\n\n");
}
