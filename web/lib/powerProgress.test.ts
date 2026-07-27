/**
 * powerProgress.test.ts — `npx tsx lib/powerProgress.test.ts` from web/.
 * Plain node, same tiny assert harness the other libs use.
 *
 * THE CONTRACT TABLE below is the cross-package agreement with
 * mobile/src/lib/powerProgress.test.ts. web/ and mobile/ have no shared build,
 * so the only thing stopping the two from drifting is that both sides assert
 * the same table — and both mirror desktop/agent/reboot_recovery_test.go.
 */
import {
  rebootProgressFor,
  humanizeRebootSeconds,
  REBOOT_OVERDUE_GRACE_FACTOR,
  REBOOT_ETA_LINUX_SECONDS,
  type RebootPhase,
} from "./powerProgress";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error("  ✗ " + msg);
  }
}
function eq<T>(got: T, want: T, msg: string) {
  ok(got === want, `${msg} (got ${String(got)}, want ${String(want)})`);
}

/** THE CONTRACT TABLE. Mirrored in mobile/src/lib/powerProgress.test.ts. */
const CONTRACT: Array<{
  name: string;
  reachable: boolean;
  sawUnreachable: boolean;
  elapsedSeconds: number;
  etaSeconds: number;
  phase: RebootPhase;
  done: boolean;
}> = [
  // Still answering right after the command — the reboot has NOT taken hold.
  { name: "issued", reachable: true, sawUnreachable: false, elapsedSeconds: 2, etaSeconds: 60, phase: "issued", done: false },
  // Gone, within budget: the healthy middle.
  { name: "down", reachable: false, sawUnreachable: true, elapsedSeconds: 20, etaSeconds: 60, phase: "down", done: false },
  // Just past the ETA but inside the grace factor — still "down", not a warning.
  { name: "grace", reachable: false, sawUnreachable: true, elapsedSeconds: 61, etaSeconds: 60, phase: "down", done: false },
  // Past ETA * grace — overdue, but NOT terminal.
  { name: "overdue", reachable: false, sawUnreachable: true, elapsedSeconds: 121, etaSeconds: 60, phase: "overdue", done: false },
  // Went away and came back — the only terminal success.
  { name: "recovered", reachable: true, sawUnreachable: true, elapsedSeconds: 58, etaSeconds: 60, phase: "recovered", done: true },
  // A late return is still a return.
  { name: "late recovery", reachable: true, sawUnreachable: true, elapsedSeconds: 400, etaSeconds: 60, phase: "recovered", done: true },
];

{
  for (const row of CONTRACT) {
    const got = rebootProgressFor({
      reachable: row.reachable,
      sawUnreachable: row.sawUnreachable,
      elapsedSeconds: row.elapsedSeconds,
      etaSeconds: row.etaSeconds,
    });
    eq(got.phase, row.phase, `${row.name}: phase`);
    eq(got.done, row.done, `${row.name}: done`);
  }
}

// THE guard. A machine that never went down cannot be "recovered", no matter
// how healthy the probe looks — it is simply still up, mid-shutdown.
{
  const got = rebootProgressFor({ reachable: true, sawUnreachable: false, elapsedSeconds: 2, etaSeconds: 60 });
  ok(got.phase !== "recovered", "reachable-but-never-down must NOT report recovered");
  ok(!got.done, "issued must not be terminal — the caller has to keep polling");
}

// Every phase must say something. A silent wait is the bug being fixed.
{
  for (const row of CONTRACT) {
    const got = rebootProgressFor({
      reachable: row.reachable,
      sawUnreachable: row.sawUnreachable,
      elapsedSeconds: row.elapsedSeconds,
      etaSeconds: row.etaSeconds,
    });
    ok(got.headline.length > 0, `${row.name}: has a headline`);
    ok(got.detail.length > 0, `${row.name}: has a detail`);
  }
}

// Being offline mid-reboot must read as expected, not as failure.
{
  const got = rebootProgressFor({ reachable: false, sawUnreachable: true, elapsedSeconds: 20, etaSeconds: 60, machineName: "box" });
  ok(got.detail.toLowerCase().includes("expected"), "down phase reads as expected");
  ok(got.detail.includes("40s"), "down phase carries the bounded expectation");
  eq(got.remainingSeconds, 40, "remaining countdown");
  ok(got.headline.includes("box"), "headline names the machine");
}

// Overdue is honest without claiming the machine is broken, and hands back a
// next step.
{
  const got = rebootProgressFor({ reachable: false, sawUnreachable: true, elapsedSeconds: 200, etaSeconds: 60 });
  ok(got.detail.toLowerCase().includes("not proof"), "overdue does not assert the machine is broken");
  ok(!!got.remedy, "overdue hands the user something to do");
}

// Recovery must tell the user their dev servers are gone, or they will wonder
// why the preview is blank.
{
  const got = rebootProgressFor({ reachable: true, sawUnreachable: true, elapsedSeconds: 58, etaSeconds: 60 });
  ok(got.detail.toLowerCase().includes("restart"), "recovery copy mentions restarting dev servers");
}

// The grace factor must actually buy time.
{
  eq(REBOOT_OVERDUE_GRACE_FACTOR, 2, "grace factor");
  const atEta = rebootProgressFor({ reachable: false, sawUnreachable: true, elapsedSeconds: 61, etaSeconds: 60 });
  eq(atEta.phase, "down", "61s against a 60s eta is still 'down'");
}

// A missing ETA must not produce a nonsense countdown.
{
  const got = rebootProgressFor({ reachable: false, sawUnreachable: true, elapsedSeconds: 10 });
  eq(got.remainingSeconds, REBOOT_ETA_LINUX_SECONDS - 10, "missing eta falls back to the default");
  const past = rebootProgressFor({ reachable: false, sawUnreachable: true, elapsedSeconds: 300, etaSeconds: 60 });
  eq(past.remainingSeconds, 0, "remaining never goes negative");
}

{
  eq(humanizeRebootSeconds(0), "0s", "humanize 0");
  eq(humanizeRebootSeconds(45), "45s", "humanize 45");
  eq(humanizeRebootSeconds(60), "1m", "humanize 60");
  eq(humanizeRebootSeconds(90), "1m 30s", "humanize 90");
  eq(humanizeRebootSeconds(-5), "0s", "humanize negative");
}

console.log(`powerProgress.test.ts: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
