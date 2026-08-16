// Owner resource facts from /dev/status. This module intentionally has no
// participant, viewer, guest, role, join, or shared-machine model.

export interface VibeResource {
  type: "port" | "device";
  kind: string; // "metro" | "flutter" | "ios-simulator" | …
  value: string; // "8083" | "323C65E7-…"
  label: string; // agent-provided human label
  since?: string;
}

/** Port/device facts as they arrive on /dev/status (same fields, flat). */
export interface DevStatusResources {
  port?: number;
  preferredPort?: number;
  portSubstituted?: boolean;
  resources?: VibeResource[];
  vibeSessionId?: string;
}

// ─── ports ───────────────────────────────────────────────────────────────────

/**
 * One line describing where this dev server is actually served.
 *
 * The substitution case is the one that matters: silently binding a different
 * port than the framework's default leaves the user reading logs that mention a
 * port they never chose. Say it, once, plainly.
 */
export function describePort(status: DevStatusResources | null | undefined): string | null {
  if (!status || !status.port) return null;
  if (status.portSubstituted && status.preferredPort && status.preferredPort !== status.port) {
    return `serving on :${status.port} (:${status.preferredPort} was already in use on this machine)`;
  }
  return `serving on :${status.port}`;
}

/** "flutter on :9100 · ios-simulator 323C65E7" — resources in one short line. */
export function describeResources(resources: VibeResource[] | null | undefined): string {
  if (!resources || resources.length === 0) return "";
  return resources.map((r) => r.label).join(" · ");
}
