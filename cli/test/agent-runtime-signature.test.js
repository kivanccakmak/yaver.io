"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ensureValidMacSignature } = require("../src/agent-runtime");

test("valid Developer ID signatures are never replaced with ad-hoc signatures", () => {
  const calls = [];
  const action = ensureValidMacSignature("/tmp/yaver", (command, args) => {
    calls.push([command, args]);
    return { status: 0 };
  });

  assert.equal(action, "preserve-valid-signature");
  assert.deepEqual(calls, [["codesign", ["--verify", "--strict", "/tmp/yaver"]]]);
});

test("an invalid downloaded signature is repaired once with an ad-hoc signature", () => {
  const calls = [];
  const action = ensureValidMacSignature("/tmp/yaver", (command, args) => {
    calls.push([command, args]);
    return { status: calls.length === 1 ? 1 : 0 };
  });

  assert.equal(action, "resign-macos-adhoc");
  assert.deepEqual(calls, [
    ["codesign", ["--verify", "--strict", "/tmp/yaver"]],
    ["codesign", ["--force", "--sign", "-", "/tmp/yaver"]],
  ]);
});
