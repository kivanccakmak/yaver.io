/**
 * runnerPollPolicy — how often to re-probe the box's runners, and when a probe
 * result is materially NEW. Pure (no React, no react-native imports) so it is
 * unit-testable: `node --experimental-strip-types --test src/lib/runnerPollPolicy.test.mts`.
 *
 * WHY THIS EXISTS — the banner re-render storm (2026-07-26)
 *
 * The user: "i really hate this opencode etc super high frequency refresh at
 * mobile ui at banner". The remote-box banner and its runner chip visibly
 * flickered many times per second.
 *
 * It was not a per-second clock and not an unmemoized context. It was an effect
 * that DEPENDED ON THE STATE IT SET:
 *
 *     useEffect(() => {
 *       void refreshRunnerState();                      // sets runnersFetchState
 *       const ms = runnersFetchState === "ok" ? 30000 : 5000;
 *       const iv = setInterval(() => void refreshRunnerState(), ms);
 *       return () => clearInterval(iv);
 *     }, [activeDevice?.id, connectionStatus, refreshRunnerState, runnersFetchState]);
 *                                                        ^^^^^^^^^^^^^^^^^^
 *
 * refreshRunnerState sets "loading", then the probe result. Whenever that
 * result is anything other than "ok", every write CHANGES the dep, so React
 * tears the effect down and runs it again — which calls refreshRunnerState
 * immediately, which writes "loading" again, which re-fires the effect, forever.
 * The `setInterval` never survives long enough to fire once: the intended
 * "retry every 5s" became "retry as fast as the probe answers".
 *
 * And the probe can answer with NO delay at all. `quicClient.getRunnersProbe()`
 * returns `{state: "network-error"}` synchronously when the transport is down
 * while React still believes connectionStatus === "connected" — an optimistic
 * state this codebase sets deliberately. So the loop ran at render speed, not
 * network speed. That is the "super high frequency": the banner text alternated
 * between "OpenCode status loading" and "OpenCode status unavailable"
 * (runnerBannerState.ts:70-77) as fast as the device could paint.
 *
 * THE RULE THIS ENCODES
 *
 * A poll cadence is a POLICY, not a subscription. Compute it from the current
 * state by CALLING a function, never by listing that state as an effect
 * dependency — a dependency makes the poller restart itself, and a poller that
 * restarts itself is not a poller.
 *
 * `minGapMs` is the second belt: the caller schedules the next probe only after
 * the previous one settles, and never sooner than this, so no future edit can
 * reintroduce an unthrottled spin even if the dep list regresses.
 */

import type { RunnerFetchState } from "./runnerBannerState";

/** Steady-state cadence once the box answered cleanly. Slow on purpose — a
 *  healthy runner list barely changes, and every probe is a round trip the
 *  user pays for. */
export const RUNNER_POLL_HEALTHY_MS = 30_000;

/** Retry cadence while the probe is unhappy. Fast enough that a box coming back
 *  is noticed promptly, slow enough to be a poll rather than a storm. */
export const RUNNER_POLL_RETRY_MS = 5_000;

/** Hard floor between two probes, whatever the state. This is what makes a
 *  synchronous failure (transport down, `getRunnersProbe` returning without a
 *  network round trip) cost 2s instead of one render frame. */
export const RUNNER_POLL_MIN_GAP_MS = 2_000;

/**
 * Whether runner discovery may probe the machine that actually owns the
 * selected runner seat.
 *
 * The focused DeviceContext status is not transport truth: during reconnect it
 * can still say `connecting` after that machine's pooled client is live. The
 * opposite is also possible (an optimistic `connected` while the exact pooled
 * client is down). When a target id is known, only that target's membership in
 * the live pool decides. The focused status is a legacy fallback for the brief
 * cold-start window before device selection has hydrated.
 */
export function shouldPollRunnerState(input: {
  targetDeviceId?: string | null;
  connectedDeviceIds: readonly string[];
  focusedConnectionStatus: string;
}): boolean {
  if (input.targetDeviceId) {
    return input.connectedDeviceIds.includes(input.targetDeviceId);
  }
  return input.focusedConnectionStatus === "connected" || input.connectedDeviceIds.length > 0;
}

/**
 * How long to wait before the NEXT runner probe, given how the last one went.
 *
 * Call this; never put `fetchState` in an effect's dependency array. See the
 * module header for what happens when you do.
 */
export function runnerPollCadenceMs(fetchState: RunnerFetchState): number {
  const ms = fetchState === "ok" ? RUNNER_POLL_HEALTHY_MS : RUNNER_POLL_RETRY_MS;
  return Math.max(RUNNER_POLL_MIN_GAP_MS, ms);
}

/** Structural subset of `RunnerInfo` compared below. Kept structural rather
 *  than importing the type so this module stays off the react-native chain. */
export interface ComparableRunner {
  id?: string;
  name?: string;
  installed?: boolean;
  ready?: boolean;
  authConfigured?: boolean;
  authPresent?: boolean;
  authVerified?: boolean;
  authVerifiedAt?: number;
  authSource?: string;
  error?: string;
  warning?: string;
  isDefault?: boolean;
  models?: { id?: string; name?: string; isDefault?: boolean }[];
}

/** Canonical auth fields returned by `/runner-auth/status`. Kept structural so
 * this policy module remains independent of the transport implementation. */
export interface ComparableRunnerAuthStatus {
  id?: string;
  installed?: boolean;
  ready?: boolean;
  authConfigured?: boolean;
  authPresent?: boolean;
  authVerified?: boolean;
  authVerifiedAt?: number;
  authSource?: string;
  warning?: string;
  error?: string;
}

/**
 * Reconcile the model-rich `/agent/runners` inventory with the dedicated auth
 * status operation. The latter is what Settings and the box audit use; Tasks
 * previously trusted only the inventory row, so a stale negative rendered
 * "needs sign-in" even while `codex login status` was authenticated.
 *
 * IDs absent from the auth response are left untouched. This makes the merge
 * additive for old agents and prevents a partial audit from erasing a runner.
 */
export function reconcileRunnerAuthStatus<T extends ComparableRunner>(
  runners: T[],
  authRows: ComparableRunnerAuthStatus[] | null,
): T[] {
  if (!authRows) return runners;
  const authByID = new Map(
    authRows
      .filter((row) => String(row.id ?? "").trim() !== "")
      .map((row) => [String(row.id).trim().toLowerCase(), row]),
  );
  let changed = false;
  const next = runners.map((runner) => {
    const auth = authByID.get(String(runner.id ?? "").trim().toLowerCase());
    if (!auth) return runner;
    const merged = {
      ...runner,
      installed: auth.installed ?? runner.installed,
      ready: auth.ready ?? runner.ready,
      authConfigured: auth.authConfigured ?? runner.authConfigured,
      authPresent: auth.authPresent ?? (runner as T & { authPresent?: boolean }).authPresent,
      authVerified: auth.authVerified ?? (runner as T & { authVerified?: boolean }).authVerified,
      authVerifiedAt: auth.authVerifiedAt ?? (runner as T & { authVerifiedAt?: number }).authVerifiedAt,
      authSource: auth.authSource ?? (runner as T & { authSource?: string }).authSource,
      warning: auth.warning ?? "",
      error: auth.error ?? "",
    } as T;
    if (sameRunnerList([runner], [merged])) return runner;
    changed = true;
    return merged;
  });
  return changed ? next : runners;
}

function sameModels(a: ComparableRunner["models"], b: ComparableRunner["models"]): boolean {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    if (x[i]?.id !== y[i]?.id) return false;
    if (x[i]?.name !== y[i]?.name) return false;
    if (!!x[i]?.isDefault !== !!y[i]?.isDefault) return false;
  }
  return true;
}

/**
 * True when two runner probes describe the same runners in the same state.
 *
 * The probe hands back a freshly-parsed array every 30s, so `availableRunners`
 * got a new IDENTITY on every tick even when the box's answer was byte-identical
 * — and that identity is a dependency of the runner-label useMemos, of
 * `deriveRunnerBannerState`, and therefore of the banner's text. Holding the
 * previous array when nothing moved is what makes the banner change only when
 * the underlying fact changes.
 *
 * Every field compared here is one the banner or the picker actually renders or
 * branches on (see runnerBannerState.ts). Adding a field the UI reads without
 * adding it here makes the UI silently stop reacting to it — the opposite bug,
 * and just as bad.
 */
export function sameRunnerList(a: ComparableRunner[], b: ComparableRunner[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i] ?? {};
    const q = b[i] ?? {};
    if (
      p.id !== q.id ||
      p.name !== q.name ||
      p.installed !== q.installed ||
      p.ready !== q.ready ||
      p.authConfigured !== q.authConfigured ||
      p.authPresent !== q.authPresent ||
      p.authVerified !== q.authVerified ||
      p.authVerifiedAt !== q.authVerifiedAt ||
      (p.authSource ?? "") !== (q.authSource ?? "") ||
      (p.error ?? "") !== (q.error ?? "") ||
      (p.warning ?? "") !== (q.warning ?? "") ||
      !!p.isDefault !== !!q.isDefault
    ) {
      return false;
    }
    if (!sameModels(p.models, q.models)) return false;
  }
  return true;
}

/** Structural subset of `AgentStatus` that the banner renders. */
export interface ComparableAgentStatus {
  runner?: {
    id?: string;
    name?: string;
    installed?: boolean;
    ready?: boolean;
    authConfigured?: boolean;
    error?: string;
  };
  runningTasks?: number;
}

/**
 * True when two agent-status snapshots would render the same banner.
 *
 * `/agent/status` also carries `runnerProcesses` (live PIDs) and `system`
 * (hostname/os/arch/memoryMb). PIDs and free memory move on every poll and the
 * banner shows NEITHER, so comparing them would guarantee a new object every
 * 30s — the identity churn this function exists to stop, wearing a disguise.
 * They are excluded on purpose; only what `deriveRunnerBannerState` reads is
 * compared. A consumer that starts rendering a system field must add it here.
 */
export function sameAgentStatus(
  a: ComparableAgentStatus | null,
  b: ComparableAgentStatus | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const p = a.runner ?? {};
  const q = b.runner ?? {};
  return (
    p.id === q.id &&
    p.name === q.name &&
    p.installed === q.installed &&
    p.ready === q.ready &&
    p.authConfigured === q.authConfigured &&
    (p.error ?? "") === (q.error ?? "") &&
    (a.runningTasks ?? 0) === (b.runningTasks ?? 0)
  );
}
