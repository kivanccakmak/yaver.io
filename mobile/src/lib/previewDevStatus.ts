import type { DevServerStatus } from "./quic";
import { isActiveDevServerStatus } from "./devServerState.ts";

/** Keep an already-open preview mounted across a transient /dev/status fetch
 * failure. The WebView owns its own request/retry lifecycle; replacing a good
 * status with `{error:"Failed to fetch", bundleUrl:""}` unmounted that
 * WebView mid-bundle and guaranteed that its paint probe could never arrive.
 */
export function reconcilePreviewDevStatus(
  previous: DevServerStatus | null,
  incoming: DevServerStatus | null,
  previewOpen: boolean,
): DevServerStatus | null {
  const incomingActive = isActiveDevServerStatus(incoming);
  const incomingError = Boolean(incoming?.error);
  if (
    previewOpen &&
    isActiveDevServerStatus(previous) &&
    (incoming == null || incomingError) &&
    !incomingActive
  ) {
    return previous;
  }
  return incoming && (incomingActive || incomingError) ? incoming : null;
}

/** A tap on Open in Yaver should use the last measured active route when the
 * immediate refresh alone fails. The next poll can refresh it; a one-packet
 * relay miss must not turn a green running card into a dead-end alert. */
export function usablePreviewDevStatus(
  fresh: DevServerStatus | null,
  previous: DevServerStatus | null,
): DevServerStatus | null {
  if (isActiveDevServerStatus(fresh)) return fresh;
  if (isActiveDevServerStatus(previous)) return previous;
  return fresh;
}

/** A previously measured active route is sufficient for an explicit Open tap.
 * Rechecking it is useful telemetry, but must run in the background: a stalled
 * relay request must never turn a visible, working Open action into a no-op.
 */
export function canOpenPreviewBeforeRefresh(
  previous: DevServerStatus | null | undefined,
): previous is DevServerStatus {
  return isActiveDevServerStatus(previous);
}
