// browserLaneDoctor.test.mts — ready server + blank/script failure must become
// an operation-level browser-lane diagnosis, not a hidden issue counter.
// Run: node --experimental-strip-types --test src/lib/browserLaneDoctor.test.mts

import test from "node:test";
import assert from "node:assert/strict";

import {
  browserLaneProbeLine,
  doctorBrowserLane,
  probeBrowserResource,
  reconcileBrowserLaneProbe,
  shouldRetryBrowserResourceFailure,
  shouldRunBrowserLaneDoctor,
} from "./browserLaneDoctor.ts";

test("doctor preserves a structured relay HTTP refusal instead of returning unavailable", async () => {
  const probe = await doctorBrowserLane(
    { baseUrl: "https://relay.example/d/device", getAuthHeaders: () => ({ Authorization: "Bearer test" }) } as any,
    1,
    (async () => new Response(JSON.stringify({ code: "RELAY_PASSWORD_INVALID", error: "invalid relay password" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch,
  );
  assert.equal(probe.ok, false);
  assert.equal(probe.stage, "probe-http");
  assert.equal(probe.httpStatus, 401);
  assert.match(probe.detail || "", /RELAY_PASSWORD_INVALID/);
  assert.match(probe.remedy || "", /Reconnect/);
});

test("doctor names an invalid success envelope", async () => {
  const probe = await doctorBrowserLane(
    { baseUrl: "https://relay.example/d/device", getAuthHeaders: () => ({}) } as any,
    1,
    (async () => new Response("{}", { status: 200 })) as typeof fetch,
  );
  assert.equal(probe.stage, "probe-response");
  assert.equal(probe.ok, false);
});

test("resource probe reproduces the exact scoped lane without downloading the bundle", async () => {
  let method = "";
  let requested = "";
  const probe = await probeBrowserResource(
    { getAuthHeaders: () => ({ Authorization: "Bearer test", "X-Relay-Password": "test" }) } as any,
    "https://relay.example/d/device/dev-web/?token=secret&__rp=secret",
    "/d/device/dev-web/node_modules/expo-router/entry.bundle?platform=web&token=secret",
    (async (url, init) => {
      requested = String(url);
      method = String(init?.method);
      return new Response(null, { status: 401, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  );
  assert.equal(method, "HEAD");
  assert.doesNotMatch(requested, /token=|__rp=/);
  assert.equal(probe.stage, "resource-http");
  assert.equal(probe.httpStatus, 401);
});

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

test("the phone's empty mount overrides an agent-side rendered verdict", () => {
  const result = reconcileBrowserLaneProbe(
    { ok: true, stage: "rendered", detail: "the project painted real content in the browser lane" },
    { reason: "empty_mount", mountId: "root", mountChildren: 0 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.stage, "client-render");
  assert.match(result.detail || "", /empty_mount/);
  assert.match(result.detail || "", /#root children 0/);
});

test("a rendered phone probe preserves the agent verdict", () => {
  const probe = { ok: true, stage: "rendered" } as const;
  assert.equal(
    reconcileBrowserLaneProbe(probe, { reason: "mount_has_visible_content", mountId: "root", mountChildren: 1 }),
    probe,
  );
  assert.equal(
    reconcileBrowserLaneProbe(probe, { reason: "mount_without_visible_content", mountId: "root", mountChildren: 1 }),
    probe,
  );
});

test("only a pre-paint script failure auto-retries", () => {
  assert.equal(shouldRetryBrowserResourceFailure({ tag: "SCRIPT", contentLoaded: false }), true);
  assert.equal(shouldRetryBrowserResourceFailure({ tag: "SCRIPT", contentLoaded: true }), false);
  assert.equal(shouldRetryBrowserResourceFailure({ tag: "IMG", contentLoaded: false }), false);
});
