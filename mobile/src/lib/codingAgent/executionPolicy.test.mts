import test from "node:test";
import assert from "node:assert/strict";

import { capabilitiesForSurface, effectOf, isGitFinalizationRequest, toolsForRun } from "./executionPolicy.ts";
import type { CodingTool } from "./sandboxTools.ts";

const tool = (name: string, mutating: boolean, effect?: CodingTool["effect"]): CodingTool => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} },
  mutating,
  effect,
  async invoke() { return { ok: true }; },
});

const tools = [
  tool("read_file", false),
  tool("git_status", false),
  tool("write_file", true, "workspace"),
  tool("git_commit", true, "repository"),
  tool("git_push", true, "network"),
  tool("future_unknown_mutation", true),
];

test("audit exposes only read operations", () => {
  assert.deepEqual(toolsForRun(tools, "audit").map((item) => item.name), ["read_file", "git_status"]);
});

test("vibe permits file edits but never model-driven commit or push", () => {
  assert.deepEqual(toolsForRun(tools, "vibe").map((item) => item.name), ["read_file", "git_status", "write_file"]);
  assert.equal(effectOf(tools[5]), "repository");
});

test("full GUI surfaces finish locally while companions hand off", () => {
  for (const surface of ["desktop_gui", "web", "phone", "tablet", "xr"] as const) {
    const capability = capabilitiesForSurface(surface);
    assert.equal(capability.undoTurn, true);
    assert.equal(capability.commit, "local");
    assert.equal(capability.push, "local");
  }
  for (const surface of ["watch", "car", "tv"] as const) {
    const capability = capabilitiesForSurface(surface);
    assert.equal(capability.commit, "handoff");
    assert.equal(capability.push, "handoff");
    assert.ok(capability.reason);
  }
});

test("compact-surface finalization classifier catches Git commit/push without hijacking app pushes", () => {
  assert.equal(isGitFinalizationRequest("commit these changes"), true);
  assert.equal(isGitFinalizationRequest("push the current git branch"), true);
  assert.equal(isGitFinalizationRequest("push the build to my phone"), false);
  assert.equal(isGitFinalizationRequest("show git status"), false);
});
