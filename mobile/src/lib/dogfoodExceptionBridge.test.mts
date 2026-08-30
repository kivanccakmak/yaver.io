import assert from "node:assert/strict";
import test from "node:test";

import {
  DOGFOOD_EXCEPTION_CAPTURE_SCRIPT,
  dogfoodExceptionFixPrompt,
  parseDogfoodGuestException,
} from "./dogfoodExceptionBridge.ts";

test("split-bundle 404 is a named Dogfood exception with its evidence intact", () => {
  const exception = parseDogfoodGuestException(JSON.stringify({
    type: "yaver.dogfood.exception",
    kind: "error",
    message: "Failed to load split bundle from URL: https://public.yaver.io/src/lib/auth.bundle?platform=web 404 page not found",
    stack: "at loadBundle (metro-runtime.js:42)",
    source: "https://public.yaver.io/src/lib/auth.bundle?platform=web",
    url: "https://public.yaver.io/d/device/dev/",
    capturedAt: 123,
  }));

  assert.equal(exception?.code, "DOGFOOD_SPLIT_BUNDLE_LOAD_FAILED");
  assert.match(exception?.stack || "", /loadBundle/);
  assert.match(exception?.url || "", /\/d\/device\/dev\//);
});

test("fix prompt carries structured exception, scoped route, checkout, and stack", () => {
  const exception = parseDogfoodGuestException(JSON.stringify({
    type: "yaver.dogfood.exception",
    kind: "unhandledrejection",
    message: "boom",
    stack: "Error: boom\n at auth.ts:7",
  }))!;
  const prompt = dogfoodExceptionFixPrompt({
    exception,
    checkout: "/example/yaver.io",
    previewUrl: "https://relay.example/d/device/dev/?platform=web&token=private",
    deviceName: "selected box",
  });
  assert.match(prompt, /DOGFOOD_GUEST_EXCEPTION/);
  assert.match(prompt, /auth\.ts:7/);
  assert.match(prompt, /\/example\/yaver\.io/);
  assert.match(prompt, /\/d\/device\/dev\//);
  assert.match(prompt, /token=%5Bredacted%5D/);
  assert.doesNotMatch(prompt, /token=private/);
  assert.match(prompt, /untrusted runtime evidence/);
});

test("capture script listens before guest code and includes resource failures", () => {
  assert.match(DOGFOOD_EXCEPTION_CAPTURE_SCRIPT, /addEventListener\("error"/);
  assert.match(DOGFOOD_EXCEPTION_CAPTURE_SCRIPT, /addEventListener\("unhandledrejection"/);
  assert.match(DOGFOOD_EXCEPTION_CAPTURE_SCRIPT, /Failed to load resource/);
  assert.match(DOGFOOD_EXCEPTION_CAPTURE_SCRIPT, /ReactNativeWebView/);
});
