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

// ------------------------------------------- the 2026-07-27 revocation

/**
 * THE ROW THE USER'S OWN BOX ACTUALLY SHIPPED while Claude Code was answering
 * "Please run /login · API Error: 401 OAuth access token has been revoked."
 *
 * Under the old contract this took the zero-check fast path and opened a
 * terminal onto a dead session. `authVerified` now means "the provider
 * answered", and `authPresent` carries the old local claim, so this row is
 * presence-only and must NOT fast-path.
 */
const CLAUDE_PRESENT_ONLY: RunnerStatusRow = {
  runnerId: "claude",
  status: "ready",
  ready: true,
  installed: true,
  authConfigured: true,
  authPresent: true,
  authVerified: false,
  authSource: "claude.ai · max",
};

test("presence-only no longer takes the zero-check fast path", () => {
  const d = decideRunnerLaunchGate({
    runner: "claude",
    deviceRunners: [CLAUDE_PRESENT_ONLY],
    elapsedMs: 0,
  });
  assert.notEqual(d.kind, "open");
  assert.equal(d.kind, "open-degraded");
  assert.equal(d.kind === "open-degraded" && d.via, "presence-only");
});

test("presence-only still opens the terminal, with the sign-in affordance beside it", () => {
  const d = decideRunnerLaunchGate({
    runner: "claude",
    deviceRunners: [CLAUDE_PRESENT_ONLY],
    elapsedMs: 0,
  });
  assert.equal(decisionOpensTerminal(d), true, "blocking would wall off users whose credential is fine");
  assert.equal(d.kind === "open-degraded" && d.signInAffordance, true);
  assert.match(d.kind === "open-degraded" ? d.banner : "", /claude\.ai · max/);
});

test("a revoked row routes to sign-in even while it still claims ready", () => {
  // The agent sets authVerified TRUE on a rejection — it is verified evidence,
  // of the negative. authConfigured false is the signal that must win, and it
  // must win regardless of what `ready` says.
  const revoked: RunnerStatusRow = {
    runnerId: "claude",
    status: "ready",
    ready: true,
    installed: true,
    authConfigured: false,
    authVerified: true,
    warning: "Claude Code's OAuth access token has been REVOKED by the provider",
  };
  const d = decideRunnerLaunchGate({ runner: "claude", deviceRunners: [revoked], elapsedMs: 0 });
  assert.equal(d.kind, "sign-in");
  assert.match(d.kind === "sign-in" ? d.reason : "", /REVOKED/);
});

test("agents older than the split keep their fast path (no regression)", () => {
  // 1.99.278–1.99.383 send authVerified with the OLD meaning and no
  // authPresent. Treating that as presence-only would degrade every existing
  // box for no gain.
  const d = decideRunnerLaunchGate({
    runner: "claude",
    deviceRunners: [CLAUDE_VERIFIED],
    elapsedMs: 0,
  });
  assert.equal(d.kind, "open");
  assert.equal(d.kind === "open" && d.via, "device-verified");
});

test("a live probe cannot manufacture 'verified' from presence alone", () => {
  const out = probeFromStatusRow(CLAUDE_PRESENT_ONLY, "claude");
  assert.notEqual(out.state, "verified", "the live route asks the same local store — same blind spot");
  assert.equal(out.state, "error");
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
    [{ runnerId: "codex", installed: true, authConfigured: true, authPresent: true, authVerified: false }],
    [{ runnerId: "codex", installed: true, authConfigured: false, authVerified: true }],
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
