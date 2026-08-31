import assert from "node:assert/strict";
import test from "node:test";

import { isPhoneLocalTask, phoneLocalTurnStatus } from "./phoneLocalTaskRoutingCore.ts";

test("phone-local task identity never depends on a remote connection", () => {
  assert.equal(isPhoneLocalTask({ runnerId: "yaver-phone" }), true);
  assert.equal(isPhoneLocalTask({ source: "phone-local" }), true);
  assert.equal(isPhoneLocalTask({ runnerId: "opencode", source: "mobile" }), false);
});

test("a changed phone-local turn stays in the same conversation", () => {
  assert.equal(phoneLocalTurnStatus(0), "completed");
  assert.equal(phoneLocalTurnStatus(1), "ready");
  assert.equal(phoneLocalTurnStatus(12), "ready");
});
