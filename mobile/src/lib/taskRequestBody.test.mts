/**
 * taskRequestBody.test.mts — `npx tsx src/lib/taskRequestBody.test.mts`.
 * Ensures Cloud Workspace handoff flags are serialized only for final target
 * POSTs, not for initial task creation.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildSendTaskRequestBody } from "./taskRequestBody.ts";

test("mobile task request body omits allowLocalFallback for initial sends", () => {
  const body = buildSendTaskRequestBody({
    title: "Build apk",
    description: "",
    runner: "codex",
    codeMode: true,
  });
  assert.equal(body.source, "mobile-code");
  assert.equal(Object.prototype.hasOwnProperty.call(body, "allowLocalFallback"), false);
});

test("mobile task request body includes allowLocalFallback only for final handoff", () => {
  const body = buildSendTaskRequestBody({
    title: "Build apk",
    description: "",
    runner: "codex",
    codeMode: true,
    allowLocalFallback: true,
  });
  assert.equal(body.allowLocalFallback, true);
});

test("mobile task request body carries portable project identity and MCP allowlist", () => {
  const body = buildSendTaskRequestBody({
    title: "Audit Medici",
    description: "",
    runner: "opencode",
    codeMode: true,
    workDir: "/Users/kivanccakmak/Workspace/medici.ai",
    projectName: "medici.ai",
    mcpServers: ["tusrehber"],
  });
  assert.equal(body.projectName, "medici.ai");
  assert.equal(body.workDir, "/Users/kivanccakmak/Workspace/medici.ai");
  assert.deepEqual(body.mcpServers, ["tusrehber"]);
});

test("mobile task request body preserves explicit MCP doorway intent", () => {
  const omitted = buildSendTaskRequestBody({ title: "No tools", description: "" });
  assert.equal(Object.prototype.hasOwnProperty.call(omitted, "includeYaverMcp"), false);
  assert.equal(buildSendTaskRequestBody({ title: "Tools", description: "", includeYaverMcp: true }).includeYaverMcp, true);
  assert.equal(buildSendTaskRequestBody({ title: "No tools", description: "", includeYaverMcp: false }).includeYaverMcp, false);
});

test("mobile task request body carries askMode only when enabled (deep-audit frame)", () => {
  const plain = buildSendTaskRequestBody({
    title: "Add a button",
    description: "",
    runner: "opencode",
    codeMode: true,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(plain, "askMode"), false);

  const audit = buildSendTaskRequestBody({
    title: "Deep audit the auth flow",
    description: "",
    runner: "opencode",
    codeMode: true,
    askMode: true,
  });
  assert.equal(audit.askMode, true);
});

test("only an initializer-owned kickoff can request a hidden first turn", () => {
  const ordinary = buildSendTaskRequestBody({ title: "Add search", description: "Add search" });
  assert.equal(Object.prototype.hasOwnProperty.call(ordinary, "hideInitialPrompt"), false);

  const kickoff = buildSendTaskRequestBody({
    title: "Talos",
    description: "Ask what the app should do",
    hideInitialPrompt: true,
  });
  assert.equal(kickoff.hideInitialPrompt, true);
});
