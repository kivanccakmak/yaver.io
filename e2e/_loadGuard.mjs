// _loadGuard.mjs — never start a heavy arc on a machine that is already pinned.
//
// THE INCIDENT THAT CAUSED THIS FILE (2026-08-05). A local Yaver-in-Yaver trial
// was about to start Metro on this MacBook. A load check first showed a 1-minute
// load average of **224** — a wedged VPN network extension at 99% CPU, an
// Android emulator, and several other sessions' npm installs. Starting a Metro
// bundler and a Chrome into that would not have produced a verdict; it would
// have produced a timeout, on a machine that was already thrashing, and the arc
// would have reported the PRODUCT broken.
//
// That is the failure mode this guards: **an environment gap misreported as a
// product fault**. A false red costs exactly what a false green costs, and it
// costs it on the run that was supposed to tell you the truth.
//
// The rule this encodes, from the user's standing instruction: use RAM, SSD and
// CPU effectively, because this machine and the box are shared with other work
// at all times. A test suite that has to be the only thing running is a suite
// that does not get run.
//
// WHAT IT DOES NOT DO. It never fails a run. Refusing to test is not a test
// result, so an over-loaded machine yields a NAMED skip carrying the measured
// numbers — the same "an environment gap is not a product fault" discipline the
// arcs already use for a missing simulator.

import { execFileSync } from "node:child_process";
import { cpus, freemem, loadavg, platform, totalmem } from "node:os";

/**
 * Read this machine's pressure.
 *
 * `loadavg()[0]` is normalised per core, because 8 runnable threads means
 * something very different on a 2-core box and a 12-core laptop — and this repo
 * runs arcs on both.
 */
export function machinePressure() {
  const cores = Math.max(1, cpus()?.length || 1);
  const load1 = loadavg()[0] || 0;
  const loadPerCore = load1 / cores;

  // freemem() on macOS reports only the truly-free pages and reads alarmingly
  // low on a healthy machine, because inactive/purgeable pages are reclaimable
  // on demand. Using it as-is would skip every arc on any Mac that has been up
  // for a day. vm_stat's inactive + speculative pages are the honest headroom.
  let freeMB = Math.round(freemem() / 1024 / 1024);
  if (platform() === "darwin") {
    try {
      const out = execFileSync("vm_stat", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const pageSize = Number(/page size of (\d+)/.exec(out)?.[1] || 16384);
      const pagesOf = (label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(out)?.[1] || 0);
      const reclaimable = pagesOf("Pages free") + pagesOf("Pages inactive") + pagesOf("Pages speculative") + pagesOf("Pages purgeable");
      if (reclaimable > 0) freeMB = Math.round((reclaimable * pageSize) / 1024 / 1024);
    } catch {
      /* keep freemem()'s answer — a missing vm_stat is not worth failing over */
    }
  }
  return { cores, load1, loadPerCore, freeMB, totalMB: Math.round(totalmem() / 1024 / 1024) };
}

/** Default budget for a simulator/bundler-class arc. */
export const HEAVY = { maxLoadPerCore: 3.0, minFreeMB: 2048 };
/** Budget for an arc that is mostly network waiting (dispatch, API probes). */
export const LIGHT = { maxLoadPerCore: 8.0, minFreeMB: 512 };

export function pressureVerdict(budget = HEAVY, p = machinePressure()) {
  const reasons = [];
  if (p.loadPerCore > budget.maxLoadPerCore) {
    reasons.push(`load ${p.load1.toFixed(1)} over ${p.cores} cores = ${p.loadPerCore.toFixed(1)}/core (budget ${budget.maxLoadPerCore})`);
  }
  if (p.freeMB < budget.minFreeMB) {
    reasons.push(`${p.freeMB} MB reclaimable RAM (budget ${budget.minFreeMB} MB)`);
  }
  return { ok: reasons.length === 0, reasons, pressure: p };
}

/**
 * Wait for the machine to become quiet enough, then return ok.
 *
 * Waiting rather than skipping immediately is the point: other sessions' work
 * finishes, and an arc that waits four minutes and then measures something is
 * worth more than one that skips instantly and measures nothing. The wait is
 * hard-bounded — an unbounded wait for capacity is just a hang wearing a
 * different label, and this repo has a standing rule against those.
 */
export async function awaitCapacity({ budget = HEAVY, timeoutMs = 5 * 60_000, pollMs = 15_000, log = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = pressureVerdict(budget);
  if (last.ok) return last;

  log(`machine is busy — ${last.reasons.join("; ")}; waiting up to ${Math.round(timeoutMs / 60000)}m for capacity`);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    last = pressureVerdict(budget);
    if (last.ok) {
      log(`capacity available — load ${last.pressure.loadPerCore.toFixed(1)}/core, ${last.pressure.freeMB} MB free`);
      return last;
    }
  }
  return last; // still not ok — the caller renders a NAMED skip with the numbers
}
