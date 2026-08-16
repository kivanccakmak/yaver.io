// connectGuard.ts — pure, dependency-free connectivity-robustness primitives.
//
// THE RULE OF THUMB (enforce by construction, not vigilance):
//   1. No unbounded await in a connect/transport path. Every network or native
//      call goes through `withDeadline` so it ALWAYS settles.
//   2. No un-releasable guard. A concurrency guard must be releasable by a
//      NEWER attempt, never only by the attempt that took it.
//
// Both rules exist because of one class of bug: a single unbounded await
// upstream of an otherwise-bounded transport ladder wedges the whole attempt,
// and an attempt-owned guard turns that one hang into a PERMANENT stuck state.
// The concrete incident (2026-07-28): `NetInfo.fetch()` has no timeout and
// hangs indefinitely in the iOS simulator; it sat at the top of the mobile
// connect ladder, so it pinned the pill at "Connecting" for 30+ minutes while
// the Retry button no-op'd ("already in progress"). The relay was up the whole
// time. See project_netinfo_wedges_connect_guard.
//
// These primitives are pure (no RN, no imports) so they are unit-tested by the
// repo's `npx tsx` assert harness AND reused by any connect path — mobile
// quic.ts today, and portable to the native surfaces (tvOS/watch/Wear) that
// have their own transport code and the same wedge risk.

/**
 * Race `work` against a wall-clock deadline. On timeout, resolve with
 * `fallback` — NEVER hang, NEVER reject from the timeout. A rejection of
 * `work` BEFORE the deadline still propagates (the caller decides), but the
 * pending promise after a timeout is already handled by the race, so no
 * unhandled-rejection escapes.
 *
 * The underlying `work` is abandoned, not cancelled: if the call holds a real
 * resource (a socket), pass an AbortController-backed promise and abort in
 * `onTimeout`. For a fire-and-read like NetInfo.fetch() abandoning is fine.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  fallback: T,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } finally {
        resolve(fallback);
      }
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A concurrency guard for connect attempts that CANNOT wedge.
 *
 * `acquire()` returns an attempt id when the caller may proceed, or `null`
 * when a fresh (non-wedged) attempt already holds the guard. A guard held
 * longer than `wedgeMs` is treated as wedged — the previous attempt outlived
 * every bounded leg's budget, so it is hung on an unbounded await — and is
 * abandoned so a new attempt can proceed. The guard is therefore never honored
 * forever, which makes a permanent "Connecting" state impossible.
 *
 * `release(id)` clears the guard ONLY for the latest attempt: a stale/wedged
 * attempt that finally resolves must not clear a guard a newer attempt now
 * holds (otherwise the abandon-and-retry would immediately un-guard the retry).
 */
export class ConnectAttemptGuard {
  private inProgress = false;
  private startedAt = 0;
  private latestId = 0;

  constructor(
    private readonly wedgeMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!(wedgeMs > 0)) throw new Error("ConnectAttemptGuard: wedgeMs must be > 0");
  }

  acquire(): { id: number; abandonedWedged: boolean } | null {
    if (this.inProgress) {
      const age = this.now() - this.startedAt;
      if (age < this.wedgeMs) return null; // genuinely in progress — deny
      // Stale: the holder is hung. Abandon it and hand out a fresh id.
      const id = ++this.latestId;
      this.startedAt = this.now();
      return { id, abandonedWedged: true };
    }
    const id = ++this.latestId;
    this.inProgress = true;
    this.startedAt = this.now();
    return { id, abandonedWedged: false };
  }

  release(id: number): void {
    // Only the latest attempt may release. A wedged attempt's late release is
    // a no-op so it can't clobber the guard a newer attempt now holds.
    if (id === this.latestId) this.inProgress = false;
  }

  /** True while an attempt holds the guard (including a not-yet-abandoned
   *  wedged one). Callers that gate re-entry read this. */
  get busy(): boolean {
    return this.inProgress;
  }

  /** Age of the current holder, or 0 when free. Diagnostics only. */
  ageMs(): number {
    return this.inProgress ? this.now() - this.startedAt : 0;
  }
}
