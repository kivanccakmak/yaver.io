// powerProgress.test.mts — the post-reboot narration state machine.
// Run: npx tsx src/lib/powerProgress.test.mts
//
// THE CONTRACT TABLE below is the cross-package agreement with
// web/lib/powerProgress.test.ts. web/ and mobile/ have no shared build, so the
// only thing stopping the two from drifting is that both sides assert the same
// table — and both mirror desktop/agent/reboot_recovery_test.go.

import test from "node:test";
import assert from "node:assert/strict";
import {
  rebootProgressFor,
  humanizeRebootSeconds,
  REBOOT_OVERDUE_GRACE_FACTOR,
  REBOOT_ETA_LINUX_SECONDS,
  type RebootPhase,
} from "./powerProgress";

/** THE CONTRACT TABLE. Mirrored in web/lib/powerProgress.test.ts. */
const CONTRACT: Array<{
  name: string;
  reachable: boolean;
  sawUnreachable: boolean;
  elapsedSeconds: number;
  etaSeconds: number;
  phase: RebootPhase;
  done: boolean;
}> = [
  { name: "issued", reachable: true, sawUnreachable: false, elapsedSeconds: 2, etaSeconds: 60, phase: "issued", done: false },
  { name: "down", reachable: false, sawUnreachable: true, elapsedSeconds: 20, etaSeconds: 60, phase: "down", done: false },
  { name: "grace", reachable: false, sawUnreachable: true, elapsedSeconds: 61, etaSeconds: 60, phase: "down", done: false },
  { name: "overdue", reachable: false, sawUnreachable: true, elapsedSeconds: 121, etaSeconds: 60, phase: "overdue", done: false },
  { name: "recovered", reachable: true, sawUnreachable: true, elapsedSeconds: 58, etaSeconds: 60, phase: "recovered", done: true },
  { name: "late recovery", reachable: true, sawUnreachable: true, elapsedSeconds: 400, etaSeconds: 60, phase: "recovered", done: true },
];

test("contract table matches web", () => {
  for (const row of CONTRACT) {
    const got = rebootProgressFor({
      reachable: row.reachable,
      sawUnreachable: row.sawUnreachable,
      elapsedSeconds: row.elapsedSeconds,
      etaSeconds: row.etaSeconds,
    });
    assert.equal(got.phase, row.phase, `${row.name}: phase`);
    assert.equal(got.done, row.done, `${row.name}: done`);
  }
});

// THE guard. A box keeps answering for seconds after accepting a reboot, so
// "it answered -> recovered" would report success before the reboot took hold.
test("reachable but never down is NOT recovery", () => {
  const got = rebootProgressFor({ reachable: true, sawUnreachable: false, elapsedSeconds: 2, etaSeconds: 60 });
  assert.notEqual(got.phase, "recovered");
  assert.equal(got.phase, "issued");
  assert.equal(got.done, false, "issued must not be terminal");
});

test("every phase says something — a silent wait is the bug", () => {
  for (const row of CONTRACT) {
    const got = rebootProgressFor({
      reachable: row.reachable,
      sawUnreachable: row.sawUnreachable,
      elapsedSeconds: row.elapsedSeconds,
      etaSeconds: row.etaSeconds,
    });
    assert.ok(got.headline.length > 0, `${row.name}: headline`);
    assert.ok(got.detail.length > 0, `${row.name}: detail`);
  }
});

test("being offline mid-reboot reads as expected, not as failure", () => {
  const got = rebootProgressFor({
    reachable: false, sawUnreachable: true, elapsedSeconds: 20, etaSeconds: 60, machineName: "box",
  });
  assert.ok(got.detail.toLowerCase().includes("expected"));
  assert.ok(got.detail.includes("40s"), "carries the bounded expectation");
  assert.equal(got.remainingSeconds, 40);
  assert.ok(got.headline.includes("box"), "headline names the machine");
});

test("overdue is honest but never overclaims", () => {
  const got = rebootProgressFor({ reachable: false, sawUnreachable: true, elapsedSeconds: 200, etaSeconds: 60 });
  assert.ok(got.detail.toLowerCase().includes("not proof"));
  assert.ok(got.remedy, "overdue hands the user something to do");
  assert.equal(got.done, false, "overdue is not terminal — the machine may still come back");
});

test("recovery tells the user their dev servers are gone", () => {
  const got = rebootProgressFor({ reachable: true, sawUnreachable: true, elapsedSeconds: 58, etaSeconds: 60 });
  assert.ok(got.detail.toLowerCase().includes("restart"));
});

test("grace factor buys real time", () => {
  assert.equal(REBOOT_OVERDUE_GRACE_FACTOR, 2);
  assert.equal(
    rebootProgressFor({ reachable: false, sawUnreachable: true, elapsedSeconds: 61, etaSeconds: 60 }).phase,
    "down",
  );
});

test("missing eta falls back; remaining never negative", () => {
  assert.equal(
    rebootProgressFor({ reachable: false, sawUnreachable: true, elapsedSeconds: 10 }).remainingSeconds,
    REBOOT_ETA_LINUX_SECONDS - 10,
  );
  assert.equal(
    rebootProgressFor({ reachable: false, sawUnreachable: true, elapsedSeconds: 300, etaSeconds: 60 }).remainingSeconds,
    0,
  );
});

test("humanize", () => {
  assert.equal(humanizeRebootSeconds(0), "0s");
  assert.equal(humanizeRebootSeconds(45), "45s");
  assert.equal(humanizeRebootSeconds(60), "1m");
  assert.equal(humanizeRebootSeconds(90), "1m 30s");
  assert.equal(humanizeRebootSeconds(-5), "0s");
});
