import assert from "node:assert/strict";
import test from "node:test";
import { desktopDeviceLabel, isThisDesktopDevice, WEB_SURFACE_INFO } from "./desktopSurface";

const device = { id: "local-id", name: "Developer-Mac", platform: "macOS" };

test("plain Web UI never claims a browser is This PC", () => {
  assert.equal(isThisDesktopDevice(device.id, WEB_SURFACE_INFO), false);
  assert.equal(desktopDeviceLabel(device, WEB_SURFACE_INFO), "Developer-Mac · macOS");
});

test("desktop GUI labels only its exact agent device id as This PC", () => {
  const desktop = { isDesktop: true, localDeviceId: "local-id" };
  assert.equal(isThisDesktopDevice("local-id", desktop), true);
  assert.equal(isThisDesktopDevice("other-id", desktop), false);
  assert.equal(desktopDeviceLabel(device, desktop), "This PC — Developer-Mac · macOS");
});
