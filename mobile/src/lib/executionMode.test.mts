import assert from "node:assert/strict";
import test from "node:test";

import {
  allowsRemoteAutoConnect,
  isExplicitRemoteless,
  normalizeMobileExecutionMode,
} from "./executionMode.ts";

test("remote execution stays the default", () => {
  assert.equal(normalizeMobileExecutionMode(undefined), "remote-preferred");
  assert.equal(normalizeMobileExecutionMode("unknown"), "remote-preferred");
  assert.equal(allowsRemoteAutoConnect("remote-preferred"), true);
});

test("No remote box is explicit and suppresses auto-connect", () => {
  assert.equal(normalizeMobileExecutionMode("local-only"), "local-only");
  assert.equal(isExplicitRemoteless("local-only"), true);
  assert.equal(allowsRemoteAutoConnect("local-only"), false);
});

test("legacy auto fallback does not masquerade as an explicit selection", () => {
  assert.equal(normalizeMobileExecutionMode("auto-fallback"), "auto-fallback");
  assert.equal(isExplicitRemoteless("auto-fallback"), false);
  assert.equal(allowsRemoteAutoConnect("auto-fallback"), true);
});
