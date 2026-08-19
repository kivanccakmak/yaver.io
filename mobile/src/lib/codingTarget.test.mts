import assert from "node:assert/strict";
import test from "node:test";
import { resolveCodingTarget, targetNeedsRemoteRuntime, type CodingTarget } from "./codingTarget.ts";

const phone: CodingTarget = { kind: "phone-local", checkoutId: "sfmg", branch: "main" };
const remote: CodingTarget = { kind: "remote-box", deviceId: "box-1", projectId: "sfmg" };

test("explicit phone target blocks until a checkout exists", () => {
  const result = resolveCodingTarget(phone, { phoneCheckoutReady: false });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "phone_checkout_missing");
    assert.equal(result.route, "clone-repository");
  }
});

test("explicit remote target never falls back to the phone", () => {
  const result = resolveCodingTarget(remote, { remoteConnected: false, phoneCheckoutReady: true });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "remote_runtime_unavailable");
    assert.equal(result.route, "devices");
    assert.match(result.message, /not run on the phone/i);
  }
});

test("ready targets resolve without side effects", () => {
  assert.deepEqual(resolveCodingTarget(phone, { phoneCheckoutReady: true }), { ok: true, target: phone });
  assert.deepEqual(resolveCodingTarget(remote, { remoteConnected: true }), { ok: true, target: remote });
});

test("only phone-local coding is runtime-free", () => {
  assert.equal(targetNeedsRemoteRuntime(phone), false);
  assert.equal(targetNeedsRemoteRuntime(remote), true);
});
