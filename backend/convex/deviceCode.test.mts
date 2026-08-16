import test from "node:test";
import assert from "node:assert/strict";

import { companionSessionScopeForDeviceCode } from "./deviceCode.js";

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
