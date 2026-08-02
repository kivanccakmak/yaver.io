// attachMode.test.mts — the Attach Mode gate + nesting guard.
// Run: npx tsx src/lib/attachMode.test.mts

import test from "node:test";
import assert from "node:assert/strict";

import {
  ATTACH_SENTINEL_KEY,
  attachGateSummary,
  computeAttachGate,
  computeNestingVerdict,
} from "./attachMode.ts";
import type { BoxReadiness } from "./boxInit.ts";

function readiness(overall: BoxReadiness["overall"], overrides: Partial<BoxReadiness> = {}): BoxReadiness {
  const checks: BoxReadiness["checks"] = [
    { key: "agent", label: "Agent online", status: "ok", detail: "reachable", action: "none" },
    { key: "opencode", label: "OpenCode", status: "ok", detail: "ready", action: "none" },
    { key: "claude", label: "Claude Code", status: "ok", detail: "ready", action: "none" },
    { key: "codex", label: "Codex", status: "ok", detail: "ready", action: "none" },
  ];
  return { overall, checks, pending: [], ...overrides };
}

const ready = {
  deviceId: "dev-1",
  deviceName: "ubuntu-4gb",
  readiness: readiness("ready"),
  runner: "claude-code",
  checkoutDir: "/root/Workspace/yaver.io",
  checkoutVerified: true,
};

test("a fully configured gate can attach", () => {
  const gate = computeAttachGate(ready);
  assert.equal(gate.canAttach, true);
  assert.equal(gate.nextStep, null);
  assert.equal(attachGateSummary(gate), "ready to attach");
});

test("the gate is ORDERED — no box means box is what you're asked for", () => {
  const gate = computeAttachGate({});
  assert.equal(gate.canAttach, false);
  assert.equal(gate.nextStep?.key, "box");
  assert.equal(gate.nextStep?.action, "pick_box");
  // Downstream steps must not shout about problems the user cannot fix yet.
  const runner = gate.steps.find((s) => s.key === "runner")!;
  assert.equal(runner.status, "pending");
  assert.match(runner.detail, /pick a box first/);
});

test("every non-ok step names an action — nothing is a dead end", () => {
  const cases = [
    {},
    { deviceId: "d", readiness: readiness("ready") },
    { deviceId: "d", readiness: readiness("ready"), runner: "codex" },
  ];
  for (const c of cases) {
    for (const step of computeAttachGate(c).steps) {
      if (step.status === "blocked") {
        assert.notEqual(step.action, "none", `blocked step ${step.key} offers no fix`);
      }
      assert.ok(step.detail.trim().length > 0, `step ${step.key} has no detail`);
    }
  }
});

test("an unready box blocks and surfaces the FIRST pending check", () => {
  const gate = computeAttachGate({
    ...ready,
    readiness: readiness("not-ready", {
      pending: [
        { key: "claude", label: "Claude Code", status: "missing", detail: "not installed", action: "setup_claude" },
      ],
    }),
  });
  assert.equal(gate.canAttach, false);
  assert.equal(gate.nextStep?.key, "box");
  assert.match(gate.nextStep!.detail, /Claude Code/);
  assert.match(gate.nextStep!.detail, /not installed/);
  assert.equal(gate.nextStep!.action, "fix_box_readiness");
});

test("picking a runner the box cannot run is blocked, not silently accepted", () => {
  const r = readiness("partial");
  r.checks = r.checks.map((c) =>
    c.key === "codex" ? { ...c, status: "missing" as const, detail: "not installed" } : c,
  );
  const gate = computeAttachGate({ ...ready, runner: "codex", readiness: r });
  assert.equal(gate.canAttach, false);
  assert.equal(gate.nextStep?.key, "runner");
  assert.match(gate.nextStep!.detail, /not installed/);
});

test("NEGATIVE CONTROL: an unverified checkout blocks and names the directory", () => {
  // The client must never decide this from the path string — the agent reads
  // the project's declared identity. An unverified answer is a block.
  const gate = computeAttachGate({ ...ready, checkoutDir: "/root/some-other-repo", checkoutVerified: false });
  assert.equal(gate.canAttach, false);
  assert.equal(gate.nextStep?.key, "checkout");
  assert.match(gate.nextStep!.detail, /some-other-repo/);
  assert.match(gate.nextStep!.detail, /yaver-mobile/);
  assert.equal(gate.nextStep!.action, "set_checkout");
});

test("a checkout not yet verified is PENDING, never optimistically ok", () => {
  const gate = computeAttachGate({ ...ready, checkoutVerified: undefined });
  assert.equal(gate.canAttach, false);
  assert.equal(gate.nextStep?.key, "checkout");
  assert.equal(gate.nextStep?.status, "pending");
});

// ── Nesting ────────────────────────────────────────────────────────────────

test("NEGATIVE CONTROL: an attached instance refuses to offer Attach Mode", () => {
  for (const sentinel of ["1", "true"]) {
    const v = computeNestingVerdict(sentinel);
    assert.equal(v.mayOffer, false, `sentinel ${sentinel} should block`);
    assert.ok(v.reason && v.reason.length > 20, "a refusal must explain itself");
    assert.match(v.reason!, /host app/);
  }
});

test("a normal host instance may offer Attach Mode", () => {
  for (const sentinel of [null, undefined, "", "0", "false"]) {
    assert.equal(computeNestingVerdict(sentinel).mayOffer, true, `sentinel ${String(sentinel)}`);
  }
});

test("the sentinel key is stable — the inner app reads it by name", () => {
  assert.equal(ATTACH_SENTINEL_KEY, "yaver.attach.mode");
});
