import assert from "node:assert/strict";
import test from "node:test";
import { directoryContainsReceiver } from "./credentialHandoffDirectoryPolicy.ts";

const request = {
  version: 1 as const,
  type: "yaver-credential-request" as const,
  handoffId: "handoff",
  targetDeviceId: "client_receiver",
  targetPublicKey: "receiver-public-key",
  accountFingerprint: "account",
  createdAt: 1,
  expiresAt: 2,
};

test("same-account proof requires exact device and public key tuple", () => {
  const row = { deviceId: "client_receiver", publicKey: "receiver-public-key", platform: "android", updatedAt: 1 };
  assert.equal(directoryContainsReceiver([row], request), true);
  assert.equal(directoryContainsReceiver([{ ...row, publicKey: "attacker-key" }], request), false);
  assert.equal(directoryContainsReceiver([{ ...row, deviceId: "client_attacker" }], request), false);
});
