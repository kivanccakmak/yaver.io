// remoteCodingSelection.test.mts
// Run: npx tsx src/lib/remoteCodingSelection.test.mts

import test from "node:test";
import assert from "node:assert/strict";

import {
  adoptedRunnerControlCommand,
  HETZNER_OPENCODE_MODEL,
  isModelCompatibleWithRunnerId,
  preferredDefaultModelForRunner,
  preferredSeededRunnerForDevice,
  resolveModelForRemoteSend,
  resolveRunnerForRemoteSend,
  resolveRunnerSelectionDeviceId,
  runnerDispatchMismatch,
} from "./remoteCodingSelection.ts";

test("runner selection follows task target, then visible box, then legacy runner role", () => {
  assert.equal(resolveRunnerSelectionDeviceId({
    taskTargetDeviceId: "wizard-box",
    runnerRoleDeviceId: "runner-box",
    activeDeviceId: "focused-box",
  }), "wizard-box");
  assert.equal(resolveRunnerSelectionDeviceId({
    runnerRoleDeviceId: "runner-box",
    activeDeviceId: "focused-box",
  }), "focused-box");
  assert.equal(resolveRunnerSelectionDeviceId({ activeDeviceId: "focused-box" }), "focused-box");
  assert.equal(resolveRunnerSelectionDeviceId({ runnerRoleDeviceId: "runner-box" }), "runner-box");
});

test("visible runner selection wins over a machine primary even after focus resets hidden picker state", () => {
  assert.equal(resolveRunnerForRemoteSend({
    activeDeviceId: "mac",
    dispatchDeviceId: "ubuntu",
    primaryRunnerByDevice: { ubuntu: "opencode" },
    selectedRunner: "codex",
    userPickedRunner: false,
  }), "codex");
});

test("machine primary supplies the runner only while the visible picker is blank", () => {
  assert.equal(resolveRunnerForRemoteSend({
    activeDeviceId: "mac",
    dispatchDeviceId: "ubuntu",
    primaryRunnerByDevice: { ubuntu: "opencode" },
    selectedRunner: "",
  }), "opencode");
});

test("dispatch mismatch guard catches a selected Codex task launched as OpenCode", () => {
  assert.equal(runnerDispatchMismatch("codex", "opencode"), true);
  assert.equal(runnerDispatchMismatch("claude-code", "claude"), false);
  assert.equal(runnerDispatchMismatch("codex", ""), false);
});

test("OpenCode rejects stale Codex model ids", () => {
  assert.equal(isModelCompatibleWithRunnerId("gpt-5.4", "opencode"), false);
  assert.equal(isModelCompatibleWithRunnerId("zai-coding-plan/glm-5.2", "opencode"), true);
});

test("OpenCode send resolves past stale selected Codex model", () => {
  const resolved = resolveModelForRemoteSend({
    runnerId: "opencode",
    activeDevice: { id: "dev-1", name: "ubuntu-4gb-hel1-1", os: "linux" } as any,
    primaryModelByDevice: { "dev-1": "zai-coding-plan/glm-5.2" },
    selectedModel: "gpt-5.4",
    fallbackModel: "gpt-5.4",
    availableRunners: [
      {
        id: "opencode",
        models: [
          { id: "zai-coding-plan/glm-5.2", isDefault: true },
          { id: HETZNER_OPENCODE_MODEL },
        ],
      },
    ],
    signedInEmail: null,
    userPickedModel: true,
  });

  assert.equal(resolved, "zai-coding-plan/glm-5.2");
});

test("Codex default does not reintroduce retired or rejected models", () => {
  assert.equal(preferredDefaultModelForRunner("codex", { name: "ubuntu-4gb-hel1-1", os: "linux" }, null), "gpt-5.6-sol");
  assert.equal(preferredDefaultModelForRunner("codex", { name: "ubuntu-4gb-hel1-1", os: "linux" }, "kivanc@example.com"), "gpt-5.6-sol");
});

test("Convex-backed runner default beats an unpicked stale UI seed", () => {
  assert.equal(resolveModelForRemoteSend({
    runnerId: "codex",
    activeDevice: { id: "dev-1", os: "linux" } as any,
    selectedModel: "gpt-5.4",
    availableRunners: [{
      id: "codex",
      models: [
        { id: "gpt-5.4" },
        { id: "gpt-5.6-sol", isDefault: true },
      ],
    }],
    userPickedModel: false,
  }), "gpt-5.6-sol");
});

test("an explicit user model still wins over the Yaver global default", () => {
  assert.equal(resolveModelForRemoteSend({
    runnerId: "codex",
    activeDevice: { id: "dev-1", os: "linux" } as any,
    selectedModel: "gpt-5.6-terra",
    availableRunners: [{
      id: "codex",
      models: [{ id: "gpt-5.6-sol", isDefault: true }],
    }],
    userPickedModel: true,
  }), "gpt-5.6-terra");
});

test("seeded runner prefers a ready Codex over a merely installed Claude fallback", () => {
  assert.equal(preferredSeededRunnerForDevice({
    device: { name: "Kivanc MacBook Pro", os: "darwin" },
    signedInEmail: "kivanc@example.com",
    readyRunnerIds: ["codex"],
    installedRunnerIds: ["claude", "codex"],
  }), "codex");
});

test("adopted Codex exposes its live model chooser command", () => {
  assert.equal(adoptedRunnerControlCommand("codex"), "/model");
  assert.equal(adoptedRunnerControlCommand("claude-code"), null);
  assert.equal(adoptedRunnerControlCommand("opencode"), null);
});
