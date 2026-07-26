// devStatusPolling.ts — WHEN the phone may poll a box's /dev/status.
//
// The old gate was `connectionStatus === "connected"` — the FOCUSED client's
// mood, not the box's transport truth. After a relay restart the focused
// status can sit at "connecting"/"error" (or track a stale client entirely)
// while the box's pooled client is back up, which froze the poll and stranded
// the preview on "Waiting for the dev server to report its address…" even
// though /dev/status on the box reported running+serving. Gate on the
// connection-manager pool instead: poll exactly when the ACTIVE device's own
// pooled client is live — the same transport truth the header banner reads.
//
// Pure function so the gate is unit-testable (devStatusPolling.test.mts).
export function shouldPollDevStatus(input: {
  activeDeviceId?: string | null;
  connectedDeviceIds: readonly string[];
}): boolean {
  return !!input.activeDeviceId && input.connectedDeviceIds.includes(input.activeDeviceId);
}
