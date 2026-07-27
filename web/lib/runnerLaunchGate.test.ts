/**
 * Regression tests for the runner launch gate.
 *
 * The bug: clicking Codex on a remote box left the modal on
 * "CHECKING RUNNER AUTH · 12s" with the PTY closed, because the gate ran a
 * paid `codex exec` generation (measured 5.3 s / 6,212 tokens on the live box)
 * to rediscover something the device heartbeat already said —
 * `authVerified: true`.
 *
 * The load-bearing property here is NEGATIVE: there is no combination of
 * inputs for which this function says "keep waiting" past the budget. The
 * `verify` arm is the only waiting state and the exhaustiveness sweep at the
 * bottom proves it always converges.
 *
 * Run: npx tsx --test web/lib/runnerLaunchGate.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RUNNER_VERIFY_BUDGET_MS,
  decideRunnerLaunchGate,
  decisionOpensTerminal,
  findRunnerRow,
  isGatedRunner,
  probeFromStatusRow,
  type RunnerLaunchGateInput,
  type RunnerStatusRow,
} from "./runnerLaunchGate";

/** The exact row the live Hetzner box shipped for codex on 2026-07-27. */
const CODEX_VERIFIED: RunnerStatusRow = {
  runnerId: "codex",
  status: "ready",
  ready: true,
  installed: true,
  authConfigured: true,
  authVerified: true,
  authSource: "codex login status",
};

const CLAUDE_VERIFIED: RunnerStatusRow = {
  runnerId: "claude",
  status: "ready",
  ready: true,
  installed: true,
  authConfigured: true,
  authVerified: true,
  authSource: "claude.ai · max",
};

function gate(over: Partial<RunnerLaunchGateInput> = {}) {
  return decideRunnerLaunchGate({ runner: "codex", elapsedMs: 0, ...over });
}

// ---------------------------------------------------------------- fast path

test("verified device row opens the PTY immediately — no probe, no wait", () => {
  const d = gate({ deviceRunners: [CODEX_VERIFIED], elapsedMs: 0 });
  assert.equal(d.kind, "open");
  assert.equal(d.kind === "open" && d.via, "device-verified");
  assert.match(d.kind === "open" ? d.detail : "", /codex login status/);
});

test("the fast path does not depend on a probe ever resolving", () => {
  // This is the whole user complaint: probe null forever must NOT block.
  for (const elapsed of [0, 1_000, 12_000, 60_000]) {
    const d = gate({ deviceRunners: [CODEX_VERIFIED], probe: null, elapsedMs: elapsed });
    assert.equal(d.kind, "open", `elapsed=${elapsed}`);
  }
});

test("claude takes the same fast path", () => {
  const d = gate({ runner: "claude", deviceRunners: [CLAUDE_VERIFIED] });
  assert.equal(d.kind, "open");
  assert.match(d.kind === "open" ? d.detail : "", /Claude is signed in/);
});

test("rows keyed by `id` (the /runner-auth/status shape) match too", () => {
  const row: RunnerStatusRow = { ...CODEX_VERIFIED, runnerId: undefined, id: "codex" };
  assert.equal(findRunnerRow([row], "codex")?.authSource, "codex login status");
  assert.equal(gate({ deviceRunners: [row] }).kind, "open");
});

test("claude-code is normalized to claude when matching rows", () => {
  const row = { ...CLAUDE_VERIFIED, runnerId: "claude-code" };
  assert.equal(findRunnerRow([row], "claude")?.authSource, "claude.ai · max");
  assert.equal(gate({ runner: "claude", deviceRunners: [row] }).kind, "open");
});

test("a verified credential does NOT open when the runner is not runnable", () => {
  // codex with the Linux userns sandbox blocked: good token, unusable runner.
  const d = gate({
    deviceRunners: [{ ...CODEX_VERIFIED, ready: false, error: "Linux is blocking codex's sandbox" }],
    elapsedMs: RUNNER_VERIFY_BUDGET_MS,
  });
  assert.notEqual(d.kind, "open");
  assert.equal(decisionOpensTerminal(d), true, "still must not trap the user");
});

// ---------------------------------------------------------------- sign-in

test("a row that says signed out routes straight to sign-in, with no probe", () => {
  const d = gate({
    deviceRunners: [{ runnerId: "codex", installed: true, authConfigured: false, error: "no credentials found" }],
    elapsedMs: 0,
  });
  assert.equal(d.kind, "sign-in");
  assert.equal(d.kind === "sign-in" && d.reason, "no credentials found");
});

test("status needs-auth (either spelling) routes to sign-in", () => {
  for (const status of ["needs-auth", "needs_auth"]) {
    const d = gate({ deviceRunners: [{ runnerId: "codex", installed: true, status }] });
    assert.equal(d.kind, "sign-in", status);
  }
});

test("a resolved probe saying needs-auth routes to sign-in", () => {
  const d = gate({ probe: { state: "needs-auth", reason: "run `codex login`" }, elapsedMs: 500 });
  assert.equal(d.kind, "sign-in");
  assert.equal(d.kind === "sign-in" && d.reason, "run `codex login`");
});

test("sign-in reasons are never empty — a blank remedy is the old bug", () => {
  const d = gate({ deviceRunners: [{ runnerId: "codex", installed: true, authConfigured: false }] });
  assert.equal(d.kind, "sign-in");
  assert.ok((d.kind === "sign-in" ? d.reason : "").length > 0);
});

// ---------------------------------------------------------------- fail open

test("running out of budget opens the terminal with a NAMED banner", () => {
  const d = gate({ deviceRunners: [], probe: null, elapsedMs: RUNNER_VERIFY_BUDGET_MS });
  assert.equal(d.kind, "open-degraded");
  assert.equal(d.kind === "open-degraded" && d.via, "budget-exhausted");
  assert.match(d.kind === "open-degraded" ? d.banner : "", /Codex/);
  assert.match(d.kind === "open-degraded" ? d.banner : "", /4s/);
});

test("a broken check fails OPEN, not closed", () => {
  const d = gate({ probe: { state: "error", reason: "HTTP 404" }, elapsedMs: 100 });
  assert.equal(d.kind, "open-degraded");
  assert.equal(d.kind === "open-degraded" && d.via, "check-failed");
  assert.match(d.kind === "open-degraded" ? d.banner : "", /HTTP 404/);
});

test("not-installed opens with the gap named, and is not called a login problem", () => {
  const d = gate({
    deviceRunners: [{ runnerId: "codex", installed: false, error: "codex is not installed" }],
  });
  assert.equal(d.kind, "open-degraded");
  assert.equal(d.kind === "open-degraded" && d.via, "not-installed");
});

// ---------------------------------------------------------------- bounded wait

test("an unresolved check narrates elapsed and remaining, and converges", () => {
  const d = gate({ deviceRunners: [], probe: null, elapsedMs: 1_500 });
  assert.equal(d.kind, "verify");
  assert.equal(d.kind === "verify" && d.elapsedSec, 2);
  assert.equal(d.kind === "verify" && d.remainingSec, 3);
});

test("an agent too old to report authVerified is checked, not assumed broken", () => {
  // authConfigured true + authVerified absent = pre-a63d16ead agent.
  const d = gate({
    deviceRunners: [{ runnerId: "codex", installed: true, ready: true, authConfigured: true }],
    probe: null,
    elapsedMs: 0,
  });
  assert.equal(d.kind, "verify");
});

// ---------------------------------------------------------------- ungated

test("plain shell and opencode are never gated", () => {
  for (const runner of [undefined, "", "opencode", "shell"]) {
    const d = decideRunnerLaunchGate({ runner, elapsedMs: 0, probe: null });
    assert.equal(d.kind, "open", String(runner));
    assert.equal(d.kind === "open" && d.via, "ungated");
  }
  assert.equal(isGatedRunner("opencode"), false);
  assert.equal(isGatedRunner("codex"), true);
});

// ---------------------------------------------------------- probe mapping

test("probeFromStatusRow maps the live box's real payloads", () => {
  assert.deepEqual(probeFromStatusRow(CODEX_VERIFIED, "codex"), {
    state: "verified",
    authSource: "codex login status",
  });
  assert.equal(
    probeFromStatusRow({ runnerId: "codex", installed: true, authConfigured: false, error: "no creds" }, "codex").state,
    "needs-auth",
  );
  // The opencode row the box actually shipped: installed:false with a warning.
  assert.equal(
    probeFromStatusRow(
      { runnerId: "opencode", installed: false, warning: "does not match the expected OpenCode signature" },
      "opencode",
    ).state,
    "error",
  );
  assert.equal(probeFromStatusRow(undefined, "codex").state, "error");
});

test("probeFromStatusRow never invents a needs-auth from silence", () => {
  // authConfigured absent must NOT become "sign in" — that would send a
  // signed-in user to a login screen.
  assert.equal(probeFromStatusRow({ runnerId: "codex", installed: true }, "codex").state, "error");
});

// ------------------------------------------------- the negative property

test("EXHAUSTIVE: past the budget, no input combination keeps the user waiting", () => {
  const rows: (RunnerStatusRow[] | null)[] = [
    null,
    [],
    [CODEX_VERIFIED],
    [{ runnerId: "codex" }],
    [{ runnerId: "codex", installed: true }],
    [{ runnerId: "codex", installed: false }],
    [{ runnerId: "codex", installed: true, authConfigured: true }],
    [{ runnerId: "codex", installed: true, authConfigured: false }],
    [{ runnerId: "codex", installed: true, authVerified: true, ready: false }],
    [{ runnerId: "codex", installed: true, authVerified: false, authConfigured: true }],
    [{ runnerId: "claude", installed: true, authVerified: true }],
  ];
  const probes: RunnerLaunchGateInput["probe"][] = [
    null,
    undefined,
    { state: "verified" },
    { state: "needs-auth", reason: "x" },
    { state: "error", reason: "y" },
  ];
  let checked = 0;
  for (const runner of ["codex", "claude"]) {
    for (const deviceRunners of rows) {
      for (const probe of probes) {
        for (const elapsedMs of [RUNNER_VERIFY_BUDGET_MS, RUNNER_VERIFY_BUDGET_MS + 60_000]) {
          const d = decideRunnerLaunchGate({ runner, deviceRunners, probe, elapsedMs });
          assert.notEqual(d.kind, "verify", `spun forever: ${JSON.stringify({ runner, deviceRunners, probe })}`);
          // Every terminal state must be actionable: either a terminal opens
          // or the user is handed a sign-in with a stated reason.
          assert.ok(
            decisionOpensTerminal(d) || (d.kind === "sign-in" && d.reason.length > 0),
            `dead end: ${JSON.stringify(d)}`,
          );
          checked++;
        }
      }
    }
  }
  assert.ok(checked >= 200, `expected a real sweep, ran ${checked}`);
});

test("EXHAUSTIVE: a verified row opens instantly at every elapsed value", () => {
  for (const elapsedMs of [0, 1, 999, 4_000, 25_000, 300_000]) {
    for (const probe of [null, undefined, { state: "error" as const, reason: "z" }]) {
      const d = decideRunnerLaunchGate({ runner: "codex", deviceRunners: [CODEX_VERIFIED], probe, elapsedMs });
      assert.equal(d.kind, "open", `elapsed=${elapsedMs}`);
    }
  }
});
