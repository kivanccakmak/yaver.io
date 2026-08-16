/**
 * taskProofStatus — pure mapping from proof/video capture statuses to the
 * strings the task-proof card renders. No RN imports so it runs under
 * `npx tsx` (taskProofStatus.test.ts), same pattern as connectGuard.ts.
 *
 * B12 contract: a failed/stale/unknown capture must map to a NAMED cause —
 * a non-empty sentence — never an empty string and never a spinner. The
 * inputs are deliberately loose (string | undefined) because two producers
 * feed this: Task.videoStatus ("queued"|"recording"|"ready"|"failed"|"stale")
 * and TaskProof.status ("capturing"|"ready"|"failed"), and a newer agent may
 * emit a status this build has never heard of. Unknown is still a named
 * cause, not silence.
 */

/** Statuses that mean "capture is still in flight" — render a quiet
 *  progress line, never a failure and never a play affordance. */
const IN_FLIGHT = new Set(["capturing", "queued", "recording"]);

export function proofIsInFlight(status: string | null | undefined): boolean {
  return !!status && IN_FLIGHT.has(status);
}

export function proofIsReady(status: string | null | undefined): boolean {
  return status === "ready";
}

/**
 * Named failure line for a capture status, or null when the status is not a
 * failure (ready / still in flight / absent). NEVER returns "" — every
 * failure-shaped input yields a full sentence the UI can render as-is.
 */
export function proofFailureLine(
  status: string | null | undefined,
  failedReason?: string | null,
): string | null {
  if (!status || proofIsReady(status) || proofIsInFlight(status)) return null;
  const reason = (failedReason || "").trim();
  if (status === "failed") {
    return `Demo not captured — ${reason || "the recorder failed before producing a clip"}`;
  }
  if (status === "stale") {
    return `Demo out of date — ${reason || "this clip was recorded for an earlier run of the task"}`;
  }
  // Unknown status from a newer agent: still a named cause, never silence.
  return `Demo unavailable — recorder reported "${status}"${reason ? ` (${reason})` : ""}`;
}

/** Human label for the capture lane ("browser demo" / "iOS simulator demo").
 *  Unknown lanes still get a readable "<lane> demo" caption. */
export function proofLaneLabel(lane: string | null | undefined): string | null {
  const l = (lane || "").trim();
  if (!l) return null;
  switch (l) {
    case "browser": return "browser demo";
    case "sim-ios": return "iOS simulator demo";
    case "sim-android": return "Android emulator demo";
    case "phone": return "phone demo";
    default: return `${l} demo`;
  }
}

/** mm:ss for durations/elapsed hints. Negative/NaN clamp to 0:00. */
export function formatProofDuration(totalSec: number | null | undefined): string {
  const s = Math.max(0, Math.floor(Number(totalSec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? "0" : ""}${r}`;
}
