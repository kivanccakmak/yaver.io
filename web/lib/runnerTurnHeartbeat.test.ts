// runnerTurnHeartbeat.test.ts — the runner heartbeat must be honest in all four
// states, and silent in the fifth.
// Run: npx tsx lib/runnerTurnHeartbeat.test.ts (from web/)
//
// The negative controls are the point. A heartbeat that keeps counting after the
// turn ends, or that says "last output 0s ago" about a turn that has produced
// nothing, is worse than the bare `RUNNING` pill it replaces: it looks like
// evidence.

import {
  RUNNER_QUIET_THRESHOLD_MS,
  describeRunnerTurn,
  formatOutputAge,
  formatTurnElapsed,
} from "./runnerTurnHeartbeat";

let failures = 0;
function eq(got: unknown, want: unknown, label: string) {
  if (got !== want) {
    console.error(`FAIL ${label}\n  got:  ${String(got)}\n  want: ${String(want)}`);
    failures += 1;
  } else {
    console.log(`ok ${label}`);
  }
}

const NOW = 1_800_000_000_000;

// ── formatters ──────────────────────────────────────────────────────────────
eq(formatTurnElapsed(0), "0:00", "elapsed zero");
eq(formatTurnElapsed(233_000), "3:53", "elapsed 3:53 — the exact figure the preview pane shows");
eq(formatTurnElapsed(3_723_000), "1:02:03", "elapsed past an hour keeps h:mm:ss");
eq(formatTurnElapsed(-5_000), "0:00", "negative clock skew clamps instead of printing '-1:-5'");
eq(formatOutputAge(4_000), "4s", "output age seconds");
eq(formatOutputAge(120_000), "2m", "output age whole minutes drops the ':00'");
eq(formatOutputAge(130_000), "2m 10s", "output age minutes + seconds");

// ── working: the normal case ────────────────────────────────────────────────
const working = describeRunnerTurn({
  status: "running",
  runnerName: "opencode",
  startedAt: NOW - 233_000,
  lastOutputAt: NOW - 4_000,
  now: NOW,
  hasOutput: true,
});
eq(working?.text, "opencode is working · 3:53 elapsed · last output 4s ago", "working line");
eq(working?.phase, "working", "working phase");
eq(working?.warn, false, "working is not a warning");
eq(working?.canStop, true, "a live turn can always be stopped");

// ── quiet: state the silence, never name a cause we have not measured ───────
const quiet = describeRunnerTurn({
  status: "running",
  runnerName: "opencode",
  startedAt: NOW - 600_000,
  lastOutputAt: NOW - 130_000,
  now: NOW,
  hasOutput: true,
});
eq(quiet?.phase, "quiet", "quiet phase past the threshold");
eq(quiet?.text, "opencode is working · 10:00 elapsed · no output for 2m 10s", "quiet line");
eq(quiet?.warn, true, "quiet renders in a warning tone");
// It must NOT claim the runner is stuck, hung, dead or failed. We know exactly
// one thing — nothing arrived — and naming a cause sends the user to fix a
// machine that is probably thinking.
for (const banned of ["stuck", "hung", "stalled", "dead", "failed", "crashed"]) {
  eq(quiet?.text.toLowerCase().includes(banned), false, `quiet line does not say "${banned}"`);
}

// Just under the threshold is still the normal line — no flapping at the edge.
const almostQuiet = describeRunnerTurn({
  status: "running",
  runnerName: "opencode",
  startedAt: NOW - 600_000,
  lastOutputAt: NOW - (RUNNER_QUIET_THRESHOLD_MS - 1_000),
  now: NOW,
  hasOutput: true,
});
eq(almostQuiet?.phase, "working", "one second under the threshold is still 'working'");

// ── starting: a queued turn has produced nothing, so claim nothing ──────────
const queued = describeRunnerTurn({
  status: "queued",
  runnerName: "opencode",
  startedAt: NOW - 3_000,
  lastOutputAt: NOW - 3_000,
  now: NOW,
  hasOutput: false,
});
eq(queued?.text, "opencode is starting · 0:03 elapsed", "queued line makes no output claim");
eq(queued?.text.includes("last output"), false, "queued must never report output it has not seen");

// A running turn that has not emitted yet is the same honest case.
const runningNoOutput = describeRunnerTurn({
  status: "running",
  runnerName: "opencode",
  startedAt: NOW - 8_000,
  lastOutputAt: NOW - 8_000,
  now: NOW,
  hasOutput: false,
});
eq(runningNoOutput?.phase, "starting", "running with no output yet reads as starting");

// ── silence: every terminal status renders NOTHING ──────────────────────────
for (const status of ["completed", "failed", "review", "cancelled", "stopped", "", null, undefined]) {
  eq(
    describeRunnerTurn({
      status: status as string | null | undefined,
      runnerName: "opencode",
      startedAt: NOW - 233_000,
      lastOutputAt: NOW - 4_000,
      now: NOW,
      hasOutput: true,
    }),
    null,
    `status ${JSON.stringify(status)} produces no heartbeat`,
  );
}

// ── a missing runner name must not print "undefined is working" ─────────────
const noName = describeRunnerTurn({
  status: "running",
  startedAt: NOW - 60_000,
  lastOutputAt: NOW - 1_000,
  now: NOW,
  hasOutput: true,
});
eq(noName?.text, "The runner is working · 1:00 elapsed · last output 1s ago", "unnamed runner falls back politely");

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall runner-heartbeat checks passed");
