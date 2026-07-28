/**
 * connectGuard.test.ts — `npx tsx src/lib/connectGuard.test.ts`.
 * No RN, no jest — the tiny assert harness the voice/connect libs use.
 *
 * Pins the connectivity-robustness rule of thumb behind the 2026-07-28 report:
 * the phone sat at "Connecting" for 30+ minutes and Retry did nothing because
 * NetInfo.fetch() hung (unbounded await) at the top of the connect ladder and
 * the attempt-owned guard could only be released by the attempt that took it —
 * so a single hang became a PERMANENT stuck state.
 *
 * Each block proves the fix AND breaks it: a negative-control case shows the
 * OLD behavior (unbounded / never-releasable) reproduces the wedge, so the
 * guard is not a guess. See project_netinfo_wedges_connect_guard.
 */
import { withDeadline, ConnectAttemptGuard } from "./connectGuard";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}`);
  }
}

// A promise that never settles — the exact shape of NetInfo.fetch() in the sim.
function neverResolves<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

async function run() {
  // ── withDeadline ────────────────────────────────────────────────────────
  console.log("withDeadline");

  check(
    "resolves with the work value when work wins the race",
    (await withDeadline(Promise.resolve("real"), 50, "fallback")) === "real",
  );

  // THE regression primitive. A never-resolving work MUST still settle.
  const t0 = Date.now();
  const wedged = await withDeadline(neverResolves<string>(), 30, "fallback", () => {});
  const elapsed = Date.now() - t0;
  check("a never-resolving await settles to fallback (does NOT hang)", wedged === "fallback");
  check("it settles at ~the deadline, not later", elapsed >= 25 && elapsed < 500);

  // BREAK IT: without a deadline, awaiting the same promise would hang forever.
  // We can't await-forever in a test, so assert the shape: Promise.race against
  // a settled timeout is what makes it safe. A bare await would never reach here.
  let bareAwaitReached = false;
  const bareGuardTimer = new Promise<void>((r) => setTimeout(r, 60));
  await Promise.race([
    neverResolves<void>().then(() => {
      bareAwaitReached = true;
    }),
    bareGuardTimer,
  ]);
  check(
    "negative control: a bare await on the hung promise never completes",
    bareAwaitReached === false,
  );

  check(
    "onTimeout fires exactly once on the timeout leg",
    await (async () => {
      let n = 0;
      await withDeadline(neverResolves<number>(), 20, -1, () => {
        n++;
      });
      // give any stray timers a tick — count must stay 1
      await new Promise((r) => setTimeout(r, 30));
      return n === 1;
    })(),
  );

  check(
    "a fast rejection propagates (caller decides), not swallowed as fallback",
    await (async () => {
      try {
        await withDeadline(Promise.reject(new Error("boom")), 100, "fallback");
        return false; // should have thrown
      } catch (e) {
        return e instanceof Error && e.message === "boom";
      }
    })(),
  );

  // ── ConnectAttemptGuard ─────────────────────────────────────────────────
  console.log("ConnectAttemptGuard");

  // Controllable clock so wedge timing is deterministic.
  let clock = 1000;
  const now = () => clock;
  const guard = new ConnectAttemptGuard(40000, now);

  const a = guard.acquire();
  check("first acquire succeeds", a !== null && a.abandonedWedged === false);
  check("guard reports busy while held", guard.busy === true);

  // Concurrent attempt while the holder is FRESH → denied (the real
  // "already in progress, skipping" path, correctly preserved).
  clock += 5000;
  check("concurrent acquire while fresh is denied", guard.acquire() === null);

  // THE fix: once the holder is older than wedgeMs it is treated as hung and a
  // new attempt abandons it. Old behavior (deny forever) = the permanent wedge.
  clock += 40000; // now 45s into the held attempt
  const b = guard.acquire();
  check("stale/wedged guard is abandoned so a new attempt proceeds", b !== null && b!.abandonedWedged === true);

  // The wedged attempt's late release MUST NOT clear the guard the retry holds.
  check("stale attempt's late release is a no-op (does not un-guard the retry)", (() => {
    guard.release(a!.id); // the wedged, superseded attempt finally resolving
    return guard.busy === true; // still held by b
  })());

  // The latest attempt CAN release.
  check("latest attempt releases the guard cleanly", (() => {
    guard.release(b!.id);
    return guard.busy === false;
  })());

  // After release the next attempt is fresh again (id monotonic, no wedge).
  const c = guard.acquire();
  check("post-release acquire is a normal fresh attempt", c !== null && c!.abandonedWedged === false);
  guard.release(c!.id);

  // BREAK IT: an attempt-owned guard with NO wedge break (wedgeMs → ∞) stays
  // denied forever — the original bug. Model it and assert it reproduces.
  const noBreak = new ConnectAttemptGuard(Number.MAX_SAFE_INTEGER, now);
  noBreak.acquire();
  clock += 60 * 60 * 1000; // an hour later
  check(
    "negative control: a never-wedging guard stays stuck forever (the old bug)",
    noBreak.acquire() === null,
  );

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  if (failures > 0) process.exit(1);
}

run();
