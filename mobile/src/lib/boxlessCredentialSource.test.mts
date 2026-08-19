import assert from "node:assert/strict";
import test from "node:test";
import { describeBoxlessCredential, isSafeCredentialMetadata } from "./boxlessCredentialSource";

test("describes all credential sources without exposing credentials", () => {
  assert.equal(describeBoxlessCredential({ state: "ready", source: { kind: "local-secure-store", device: "iphone" } }), "Saved on this iphone");
  assert.equal(describeBoxlessCredential({ state: "ready", source: { kind: "mobile-handoff", handoffId: "h1", expiresAt: 1 } }), "Provided by your phone (temporary)");
  assert.equal(describeBoxlessCredential({ state: "ready", source: { kind: "remote-vault", deviceId: "box-1" } }), "Provided by the selected Yaver machine");
  assert.equal(describeBoxlessCredential({ state: "ready", source: { kind: "managed-gateway" } }), "Yaver managed gateway");
});

test("missing and remote-runtime states carry a route to fix", () => {
  assert.match(describeBoxlessCredential({ state: "missing", route: { method: "POST", path: "/boxless/credentials/handoff" } }), /not configured/);
  assert.match(describeBoxlessCredential({ state: "remote-runtime-required", deviceId: "box-1", route: { method: "GET", path: "/devices" } }), /online/);
});

test("credential metadata rejects secret-shaped fields", () => {
  assert.equal(isSafeCredentialMetadata({ state: "ready", source: "remote-vault" }), true);
  assert.equal(isSafeCredentialMetadata({ state: "ready", apiKey: "sk-never-log" }), false);
  assert.equal(isSafeCredentialMetadata({ state: "ready", authorization: "Bearer never" }), false);
});
