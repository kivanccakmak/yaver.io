// runnerPollPolicy.test.mts — the banner must only change when the fact changes.
//
// Run: node --experimental-strip-types --test src/lib/runnerPollPolicy.test.mts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  RUNNER_POLL_HEALTHY_MS,
  RUNNER_POLL_MIN_GAP_MS,
  RUNNER_POLL_RETRY_MS,
  runnerPollCadenceMs,
  sameAgentStatus,
  sameRunnerList,
  type ComparableRunner,
} from "./runnerPollPolicy.ts";
import type { RunnerFetchState } from "./runnerBannerState.ts";

const ALL_STATES: RunnerFetchState[] = [
  "idle",
  "loading",
  "ok",
  "timed-out",
  "http-error",
  "network-error",
];

test("healthy boxes are polled slowly, unhappy ones retried quickly", () => {
  assert.equal(runnerPollCadenceMs("ok"), RUNNER_POLL_HEALTHY_MS);
  for (const s of ALL_STATES.filter((x) => x !== "ok")) {
    assert.equal(runnerPollCadenceMs(s), RUNNER_POLL_RETRY_MS, `state ${s}`);
  }
});

// This is the actual defect, stated as a test. `getRunnersProbe()` can return
// "network-error" with NO await — the transport is down while React still holds
// an optimistic connectionStatus === "connected". If the cadence for that state
// were 0 (or if the caller re-probed on the state change instead of on a timer)
// the poller would spin at render speed. Every reachable state must cost real
// wall-clock time.
test("no state can schedule a probe sooner than the hard floor", () => {
  for (const s of ALL_STATES) {
    assert.ok(
      runnerPollCadenceMs(s) >= RUNNER_POLL_MIN_GAP_MS,
      `state ${s} scheduled a probe after ${runnerPollCadenceMs(s)}ms, ` +
        `under the ${RUNNER_POLL_MIN_GAP_MS}ms floor — that is the storm.`,
    );
    assert.ok(Number.isFinite(runnerPollCadenceMs(s)) && runnerPollCadenceMs(s) > 0);
  }
});

// The loop the user saw was loading → error → loading → error … Walking that
// exact alternation must never produce a sub-floor gap.
test("the loading⇄error alternation the user saw stays throttled", () => {
  let elapsed = 0;
  let state: RunnerFetchState = "loading";
  for (let i = 0; i < 20; i++) {
    const gap = runnerPollCadenceMs(state);
    assert.ok(gap >= RUNNER_POLL_MIN_GAP_MS);
    elapsed += gap;
    state = state === "loading" ? "network-error" : "loading";
  }
  // 20 probes must span at least 40s, not 20 animation frames.
  assert.ok(elapsed >= 20 * RUNNER_POLL_MIN_GAP_MS, `20 probes took only ${elapsed}ms`);
});

function runner(over: Partial<ComparableRunner> = {}): ComparableRunner {
  return {
    id: "opencode",
    name: "OpenCode",
    installed: true,
    ready: true,
    authConfigured: true,
    isDefault: true,
    models: [{ id: "zai/glm-5.2", name: "GLM 5.2", isDefault: true }],
    ...over,
  };
}

test("an identical probe is not a change (this is what stops the churn)", () => {
  // Deliberately distinct object graphs — the probe parses fresh JSON each poll,
  // so identity is ALWAYS new. Only structure may decide.
  assert.ok(sameRunnerList([runner()], [runner()]));
  assert.ok(sameRunnerList([], []));
});

test("every field the banner branches on forces a change", () => {
  // Each of these drives a different runnerBannerState kind: notInstalled,
  // authNeeded, blocked/needsConfig, blocked. Missing one here means the banner
  // silently stops reacting to it — the opposite defect, equally bad.
  const cases: Partial<ComparableRunner>[] = [
    { id: "claude" },
    { name: "OpenCode (beta)" },
    { installed: false },
    { ready: false },
    { authConfigured: false },
    { error: "needs setup" },
    { warning: "stale config" },
    { isDefault: false },
    { models: [{ id: "zai/glm-4.7", name: "GLM 4.7", isDefault: true }] },
  ];
  for (const over of cases) {
    assert.equal(
      sameRunnerList([runner()], [runner(over)]),
      false,
      `changing ${JSON.stringify(over)} did not register as a change`,
    );
  }
});

test("list shape changes register", () => {
  assert.equal(sameRunnerList([runner()], []), false);
  assert.equal(sameRunnerList([runner()], [runner(), runner({ id: "claude" })]), false);
  // Order matters — the picker renders them in probe order.
  assert.equal(
    sameRunnerList(
      [runner({ id: "a" }), runner({ id: "b" })],
      [runner({ id: "b" }), runner({ id: "a" })],
    ),
    false,
  );
});

test("agent status: PIDs and free memory must NOT count as a change", () => {
  // The banner renders neither. Comparing them would hand back a new object on
  // every poll and reinstate the identity churn under a different name.
  const base = {
    runner: { id: "opencode", name: "OpenCode", installed: true, ready: true, authConfigured: true },
    runningTasks: 1,
    runnerProcesses: [{ pid: 1234, command: "opencode" }],
    system: { hostname: "box", os: "linux", arch: "arm64", memoryMb: 8192 },
  };
  const churned = {
    ...base,
    runnerProcesses: [{ pid: 9999, command: "opencode" }],
    system: { ...base.system, memoryMb: 7011 },
  };
  assert.ok(sameAgentStatus(base, churned));
});

test("agent status: what the banner DOES render forces a change", () => {
  const base = {
    runner: { id: "opencode", name: "OpenCode", installed: true, ready: true, authConfigured: true },
    runningTasks: 1,
  };
  assert.equal(sameAgentStatus(base, { ...base, runningTasks: 2 }), false);
  assert.equal(
    sameAgentStatus(base, { ...base, runner: { ...base.runner, authConfigured: false } }),
    false,
  );
  assert.equal(
    sameAgentStatus(base, { ...base, runner: { ...base.runner, error: "blocked" } }),
    false,
  );
  assert.equal(sameAgentStatus(base, null), false);
  assert.equal(sameAgentStatus(null, base), false);
  assert.ok(sameAgentStatus(null, null));
});

// ── The regression guard for the storm itself ─────────────────────────────
//
// The pure tests above prove the POLICY is sane. They cannot prove the caller
// uses it correctly — and the caller is where the bug lived. A React effect
// that writes state it also depends on type-checks perfectly, passes every unit
// test, and spins at render speed on a real phone. `tsc` has nothing to say
// about it and neither does any test that does not read the call site.
//
// So read the call site. Same approach as beaconParity.test.ts: the source on
// disk is the artifact that ships.

const tasksSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "app", "(tabs)", "tasks.tsx"),
  "utf8",
);

test("the runner poller never depends on the state it writes", () => {
  // Find the effect that starts the runner poll cycle and isolate its dep array.
  const anchor = tasksSrc.indexOf("runnerPollCadenceMs(runnersFetchStateRef.current)");
  assert.ok(anchor > 0, "the runner poller no longer calls runnerPollCadenceMs — did it regress to a literal cadence?");
  const depsAt = tasksSrc.indexOf("}, [", anchor);
  assert.ok(depsAt > anchor, "could not find the poller effect's dependency array");
  const deps = tasksSrc.slice(depsAt + 3, tasksSrc.indexOf("]", depsAt) + 1);

  assert.ok(
    !/\brunnersFetchState\b(?!Ref)/.test(deps),
    `The runner-poll effect lists \`runnersFetchState\` in its dependencies: ${deps}\n` +
      "refreshRunnerState WRITES that state, so every write tears the effect down " +
      "and immediately re-runs it — the banner re-render storm the user reported. " +
      "Read the cadence through runnersFetchStateRef instead.",
  );
});

test("the poller schedules the next probe only after the previous one settles", () => {
  const anchor = tasksSrc.indexOf("runnerPollCadenceMs(runnersFetchStateRef.current)");
  // Strip `//` comment lines — the effect's header deliberately NAMES
  // setInterval while explaining why it is gone, and prose must not fail a
  // test about code.
  const body = tasksSrc
    .slice(anchor - 900, anchor + 200)
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  // setInterval fires regardless of whether the last probe returned; a
  // self-scheduling timeout after an awaited refresh cannot overlap.
  assert.ok(
    !body.includes("setInterval"),
    "the runner poller is back on setInterval — probes can overlap and a " +
      "synchronous failure re-enters immediately. Use a self-scheduling setTimeout.",
  );
  assert.match(body, /await refreshRunnerState\(\)/);
  assert.match(body, /setTimeout\(cycle,/);
});
