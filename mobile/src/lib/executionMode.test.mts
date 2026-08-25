import assert from "node:assert/strict";
import test from "node:test";

import {
  allowsRemoteAutoConnect,
  canComposeWithRemoteless,
  executionModeForAccess,
  isExplicitRemoteless,
  normalizeMobileExecutionMode,
  remotelessAccessAllowed,
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

test("remoteless fails closed outside the server-computed owner preview", () => {
  assert.equal(remotelessAccessAllowed(true), true);
  assert.equal(remotelessAccessAllowed(false), false);
  assert.equal(remotelessAccessAllowed(undefined), false);
  assert.equal(executionModeForAccess("local-only", false), "remote-preferred");
  assert.equal(executionModeForAccess("local-only", undefined), "remote-preferred");
  assert.equal(executionModeForAccess("auto-fallback", false), "remote-preferred");
  assert.equal(executionModeForAccess("local-only", true), "local-only");
  assert.equal(canComposeWithRemoteless(false, true), true);
  assert.equal(canComposeWithRemoteless(false, false), false);
  assert.equal(canComposeWithRemoteless(true, false), true);
});
