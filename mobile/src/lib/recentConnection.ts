/**
 * Select the device the phone connected to most recently, but only while the
 * successful connection is still recent enough to be a useful default.
 *
 * This deliberately consumes successful connection timestamps, not Convex
 * `lastSeen`: a heartbeat says a machine exists, whereas a cached timestamp
 * proves this phone actually reached that specific machine.
 */
export const RECENT_CONNECTION_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SuccessfulConnectionTimestamp {
  deviceId: string;
  ts: number;
  hadSuccess: boolean;
}

export function mostRecentSuccessfulDeviceId(
  entries: readonly (SuccessfulConnectionTimestamp | null | undefined)[],
  nowMs: number = Date.now(),
): string | null {
  let winner: SuccessfulConnectionTimestamp | null = null;
  for (const entry of entries) {
    if (!entry || !entry.hadSuccess || !entry.deviceId || !Number.isFinite(entry.ts)) continue;
    const ageMs = nowMs - entry.ts;
    if (ageMs < 0 || ageMs > RECENT_CONNECTION_WINDOW_MS) continue;
    if (!winner || entry.ts > winner.ts) winner = entry;
  }
  return winner?.deviceId ?? null;
}
