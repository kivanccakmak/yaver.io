import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { createToken, decodePrivateKey, ensureApp } from "./appstore-connect-ensure-app.mjs";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("decodePrivateKey accepts raw and base64 PEM without exposing it", () => {
  const pem = "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----";
  assert.equal(decodePrivateKey(pem), pem);
  assert.equal(decodePrivateKey(Buffer.from(pem).toString("base64")), pem);
  assert.throws(() => decodePrivateKey("not-a-key"), /raw PEM/);
});

test("createToken emits an ES256 App Store Connect JWT", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const token = createToken({
    keyId: "KEY123",
    issuerId: "issuer-123",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    now: 1_700_000_000_000,
  });
  const [header, payload, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), {
    alg: "ES256",
    kid: "KEY123",
    typ: "JWT",
  });
  assert.equal(JSON.parse(Buffer.from(payload, "base64url")).aud, "appstoreconnect-v1");
  assert.equal(Buffer.from(signature, "base64url").length, 64);
});

test("ensureApp is idempotent when the app already exists", async () => {
  const calls = [];
  const result = await ensureApp({
    token: "test-token",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse(200, {
        data: [{ id: "123", attributes: { bundleId: "io.yaver.gui" } }],
      });
    },
  });
  assert.deepEqual(result, { created: false, id: "123", bundleId: "io.yaver.gui" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /filter%5BbundleId%5D=io.yaver.gui/);
});

test("ensureApp creates only the fixed Yaver desktop record", async () => {
  const calls = [];
  const result = await ensureApp({
    token: "test-token",
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (init.method === "POST") return jsonResponse(201, { data: { id: "456" } });
      return jsonResponse(200, { data: [] });
    },
  });
  assert.deepEqual(result, { created: true, id: "456", bundleId: "io.yaver.gui" });
  const payload = JSON.parse(calls[1].init.body);
  assert.deepEqual(payload.data.attributes, {
    bundleId: "io.yaver.gui",
    name: "Yaver",
    primaryLocale: "en-US",
    sku: "io-yaver-gui-macos",
  });
});
