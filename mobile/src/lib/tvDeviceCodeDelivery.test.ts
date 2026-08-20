import assert from "node:assert/strict";
import test from "node:test";

import { decideTVDeviceCodeDelivery } from "./tvDeviceCodeDelivery";

test("a one-time token wins even while the other delivery lane is claiming", () => {
  assert.equal(
    decideTVDeviceCodeDelivery({ status: "authorized", token: "one-time-bearer" }, true),
    "sign_in",
  );
});

test("only one delivery lane starts a claim", () => {
  assert.equal(decideTVDeviceCodeDelivery({ status: "authorized" }, false), "claim");
  assert.equal(decideTVDeviceCodeDelivery({ status: "authorized" }, true), "wait");
});

test("pending waits and expired rotates", () => {
  assert.equal(decideTVDeviceCodeDelivery({ status: "pending" }, false), "wait");
  assert.equal(decideTVDeviceCodeDelivery({ status: "expired" }, false), "rotate");
});
