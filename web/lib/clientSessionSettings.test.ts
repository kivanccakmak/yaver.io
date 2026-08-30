import assert from "node:assert/strict";
import test from "node:test";

import { browserSessionSettings } from "./agent-client";

test("server-rendered browser identity remains explicit", () => {
  const settings = browserSessionSettings();
  assert.equal(settings.clientSurface, "yaver-web-dashboard");
  assert.equal(settings.platform, "web");
  assert.equal(settings.deviceClass, "browser");
  assert.equal(settings.lane, "browser");
});

test("iPad browser identity is tablet rather than phone", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)" },
  });
  try {
    const settings = browserSessionSettings();
    assert.equal(settings.platform, "ios");
    assert.equal(settings.deviceClass, "tablet");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else delete (globalThis as { navigator?: Navigator }).navigator;
  }
});
