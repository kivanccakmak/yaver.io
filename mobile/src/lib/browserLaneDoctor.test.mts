// browserLaneDoctor.test.mts — ready server + blank/script failure must become
// an operation-level browser-lane diagnosis, not a hidden issue counter.
// Run: node --experimental-strip-types --test src/lib/browserLaneDoctor.test.mts

import test from "node:test";
import assert from "node:assert/strict";

import { browserLaneProbeLine, shouldRunBrowserLaneDoctor } from "./browserLaneDoctor.ts";

test("script subresource failure before first render triggers browser-lane doctor", () => {
  assert.equal(
    shouldRunBrowserLaneDoctor({
      showWebView: true,
      bundleUrl: "https://public.yaver.io/d/device/dev-web/",
      contentLoaded: false,
      failed: false,
      serverLooksReady: true,
      logLine: "[web:error] resource failed SCRIPT https://public.yaver.io/d/device/dev-web/node_modules/expo-router/entry.bundle?token=[redacted]",
    }),
    true,
  );
});

test("ready but failed before render triggers browser-lane doctor", () => {
  assert.equal(
    shouldRunBrowserLaneDoctor({
      showWebView: true,
      bundleUrl: "https://public.yaver.io/d/device/dev-web/",
      contentLoaded: false,
      failed: true,
      serverLooksReady: true,
    }),
    true,
  );
});

test("rendered or not-open previews do not probe", () => {
  assert.equal(
    shouldRunBrowserLaneDoctor({
      showWebView: true,
      bundleUrl: "https://public.yaver.io/d/device/dev-web/",
      contentLoaded: true,
      failed: true,
      serverLooksReady: true,
      logLine: "[web:error] TypeError: boom",
    }),
    false,
  );
  assert.equal(
    shouldRunBrowserLaneDoctor({
      showWebView: false,
      bundleUrl: "https://public.yaver.io/d/device/dev-web/",
      contentLoaded: false,
      failed: true,
      serverLooksReady: true,
    }),
    false,
  );
});

test("probe line names stage, status, detail, and remedy", () => {
  const line = browserLaneProbeLine({
    ok: false,
    stage: "blank",
    httpStatus: 200,
    elapsedMs: 1234,
    detail: "#root children 0",
    remedy: "check the browser console",
  });
  assert.match(line, /stage=blank/);
  assert.match(line, /http=200/);
  assert.match(line, /#root children 0/);
  assert.match(line, /remedy: check the browser console/);
});
