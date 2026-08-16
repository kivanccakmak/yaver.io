/**
 * powerProgress.ts — the sentence shown for every second a rebooting machine is
 * gone, plus the rule for when we are allowed to say it came back.
 *
 * A reboot is the one action where success looks exactly like failure: the box
 * stops answering. Before this, both surfaces fired `infra_power` and
 * immediately called `refresh()`, which lands on a machine halfway through
 * shutting down — the refresh fails, the card flips to offline, and the user
 * cannot tell whether they broke the machine or whether it is doing exactly what
 * they asked. That silence is the defect.
 *
 * THE TRAP THIS GUARDS (and the reason `sawUnreachable` exists):
 *
 *   A machine keeps answering for several seconds after it accepts a reboot,
 *   because shutdown is not instant. So "did it answer? → recovered" reports
 *   SUCCESS almost immediately, before the box has begun going down — and then
 *   the card flips to offline a moment later and stays there. Claiming recovery
 *   therefore REQUIRES having watched the machine actually disappear first.
 *
 * CONTRACT TABLE — this file and `mobile/src/lib/powerProgress.ts` must agree.
 * web/ and mobile/ share no build, so the only thing preventing drift is that
 * both sides assert the same table (see the .test.ts beside each). Change a
 * phase boundary here and mobile's test fails.
 *
 *   reachable  sawUnreachable  elapsed vs eta        phase
 *   ---------  --------------  --------------------  ---------
 *   true       false           any                   issued
 *   false      any             <= eta * GRACE        down
 *   false      any             >  eta * GRACE        overdue
 *   true       true            any                   recovered
 *
 * Pure: no clocks, no fetches. The caller supplies elapsed time and probe
 * results, so every transition is testable without rebooting anything.
 *
 * Mirrors desktop/agent/reboot_recovery.go — same phases, same grace factor.
 */

export type RebootPhase = "issued" | "down" | "recovered" | "overdue";

/** Doubling the ETA before we warn is deliberate: a warning that fires at
 *  exactly the expected return time fires on every healthy reboot that hit a
 *  slow disk, and a warning that cries wolf is one users learn to ignore. */
export const REBOOT_OVERDUE_GRACE_FACTOR = 2;

/** Defaults mirror the agent's per-platform budgets. macOS boots slower
 *  (FileVault), and calling a Mac "overdue" at 60s would train the user to
 *  ignore the warning. */
export const REBOOT_ETA_LINUX_SECONDS = 60;
export const REBOOT_ETA_DARWIN_SECONDS = 120;

export interface RebootProbe {
  /** Seconds since the reboot command was accepted. */
  elapsedSeconds: number;
  /** Expected return time for this platform, from the capability report. */
  etaSeconds?: number;
  /** Result of the most recent reachability probe. */
  reachable: boolean;
  /** True once ANY probe since the reboot was issued has failed. The gate on
   *  claiming recovery — see the trap above. */
  sawUnreachable: boolean;
  /** Used in the copy. Optional. */
  machineName?: string;
}

export interface RebootProgress {
  phase: RebootPhase;
  /** Short, states the current fact. */
  headline: string;
  /** Carries the bounded expectation, so the user can tell waiting from hung. */
  detail: string;
  remainingSeconds: number;
  elapsedSeconds: number;
  /** True only in a terminal phase — the caller stops polling. */
  done: boolean;
  /** Terminal-but-unhappy: what to do now. */
  remedy?: string;
}

/** Renders a duration the way a person waiting would say it. */
export function humanizeRebootSeconds(s: number): string {
  const v = Math.max(0, Math.round(s));
  if (v < 60) return `${v}s`;
  const m = Math.floor(v / 60);
  const rem = v % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

export function rebootProgressFor(p: RebootProbe): RebootProgress {
  const name = p.machineName?.trim() || "The machine";
  const eta = p.etaSeconds && p.etaSeconds > 0 ? p.etaSeconds : REBOOT_ETA_LINUX_SECONDS;
  const remainingSeconds = Math.max(0, eta - p.elapsedSeconds);
  const base = { remainingSeconds, elapsedSeconds: p.elapsedSeconds };

  // Recovered — and ONLY if we watched it go away first.
  if (p.reachable && p.sawUnreachable) {
    return {
      ...base,
      phase: "recovered",
      done: true,
      headline: `${name} is back online.`,
      detail:
        `Rebooted and answering again after ${humanizeRebootSeconds(p.elapsedSeconds)}. ` +
        `Dev servers and tasks did not survive the reboot — restart the ones you need.`,
    };
  }

  // Past the grace budget with no answer. Honest, but never overclaiming.
  if (!p.reachable && p.elapsedSeconds > eta * REBOOT_OVERDUE_GRACE_FACTOR) {
    return {
      ...base,
      phase: "overdue",
      // NOT terminal: the machine may still come back, and we keep watching.
      done: false,
      headline: `${name} has not come back yet.`,
      detail:
        `It has been ${humanizeRebootSeconds(p.elapsedSeconds)} and the expected return was about ` +
        `${humanizeRebootSeconds(eta)}. A reboot can legitimately take longer (disk check, FileVault, ` +
        `a slow BIOS), so this is not proof anything is wrong.`,
      remedy:
        `Yaver will keep watching. If it stays down: check the machine has power and network, and that ` +
        `the Yaver agent is set to start on boot (\`yaver serve\` installs the launchd/systemd unit).`,
    };
  }

  // Gone, on schedule. The healthy middle — must read as progress, not error.
  if (!p.reachable) {
    return {
      ...base,
      phase: "down",
      done: false,
      headline: `${name} is rebooting…`,
      detail:
        `Off the network, which is expected. Back in about ${humanizeRebootSeconds(remainingSeconds)} ` +
        `(${humanizeRebootSeconds(p.elapsedSeconds)} elapsed).`,
    };
  }

  // Still answering — the shutdown was accepted but has not taken hold.
  return {
    ...base,
    phase: "issued",
    done: false,
    headline: `Reboot accepted — ${name} is shutting down…`,
    detail:
      `Still answering while it shuts down. It should drop off the network shortly, then return in ` +
      `about ${humanizeRebootSeconds(eta)}.`,
  };
}
