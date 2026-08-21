import assert from "node:assert/strict";
import test from "node:test";
import { validateHandoffDevicePublicMetadata } from "./credentialHandoffDevicePolicy.ts";

test("handoff directory accepts public metadata only", () => {
  assert.deepEqual(validateHandoffDevicePublicMetadata({
    deviceId: "client_12345678",
    publicKey: "A".repeat(43) + "=",
    platform: "android",
  }), { deviceId: "client_12345678", publicKey: "A".repeat(43) + "=", platform: "android" });
});

test("handoff directory rejects malformed identifiers and keys", () => {
  assert.throws(() => validateHandoffDevicePublicMetadata({ deviceId: "x", publicKey: "secret", platform: "ios" }));
  assert.throws(() => validateHandoffDevicePublicMetadata({ deviceId: "client_12345678", publicKey: "A".repeat(43) + "=", platform: "" }));
});
