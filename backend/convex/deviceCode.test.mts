import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { companionSessionScopeForDeviceCode } from "./deviceCode.js";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "deviceCode.ts"), "utf8");

test("device-code companion classifier scopes watch surfaces", () => {
  assert.equal(companionSessionScopeForDeviceCode({ platform: "watchos", environment: "watch" }), "watch");
  assert.equal(companionSessionScopeForDeviceCode({ platform: "wearos" }), "watch");
  assert.equal(companionSessionScopeForDeviceCode({ platform: "wear-os" }), "watch");
});

test("device-code companion classifier scopes spatial headset surfaces", () => {
  assert.equal(companionSessionScopeForDeviceCode({ platform: "visionos" }), "vision");
  assert.equal(companionSessionScopeForDeviceCode({ platform: "android-xr" }), "vision");
  assert.equal(companionSessionScopeForDeviceCode({ environment: "xr" }), "vision");
  assert.equal(companionSessionScopeForDeviceCode({ environment: "spatial" }), "spatial");
});

test("device-code companion classifier preserves TV and full defaults", () => {
  assert.equal(companionSessionScopeForDeviceCode({ platform: "tvos", environment: "tv" }), "tv");
  assert.equal(companionSessionScopeForDeviceCode({ platform: "android-tv" }), "tv");
  assert.equal(companionSessionScopeForDeviceCode({ platform: "darwin", environment: "cli" }), "full");
  assert.equal(companionSessionScopeForDeviceCode({}), "full");
});

test("TV claims replace only this installation's prior same-user sessions", () => {
  assert.match(source, /query\("sessions"\)[\s\S]*?withIndex\("by_deviceId"/);
  assert.match(source, /session\.userId === code\.approvedUserId/);
  assert.match(source, /await ctx\.db\.delete\(session\._id\)/);
  assert.match(source, /scope: companionSessionScopeForDeviceCode\(code\)/);
});
