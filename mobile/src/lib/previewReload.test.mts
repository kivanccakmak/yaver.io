// previewReload.test.mts — shared mobile preview reload routing.
// Run: npx tsx src/lib/previewReload.test.mts

import test from "node:test";
import assert from "node:assert/strict";

import {
  planPostTaskRender,
  planPreviewReload,
  previewReloadFailureLine,
  previewReloadReachedTarget,
} from "./previewReload.ts";

test("Expo browser lane uses /dev/reload with no Hermes fallback", () => {
  const plan = planPreviewReload({
    status: { framework: "expo", devMode: "web" },
    kind: "fast",
  });
  assert.deepEqual(plan, {
    lane: "browser",
    mode: "fast",
    allowBundleFallback: false,
    shouldShowBrowserLoading: true,
    shouldOpenNativeFirst: false,
  });
});

test("Flutter browser lane uses fast/full reload without Hermes fallback", () => {
  assert.deepEqual(planPreviewReload({
    status: { framework: "flutter", devMode: "web" },
    kind: "full",
  }), {
    lane: "browser",
    mode: "full",
    allowBundleFallback: false,
    shouldShowBrowserLoading: true,
    shouldOpenNativeFirst: false,
  });
});

test("Expo native lane maps full to bundle and allows bundle fallback", () => {
  assert.deepEqual(planPreviewReload({
    status: { framework: "expo", platform: "ios" },
    kind: "full",
    bundleMounted: true,
  }), {
    lane: "native-hermes",
    mode: "bundle",
    allowBundleFallback: true,
    shouldShowBrowserLoading: false,
    shouldOpenNativeFirst: false,
  });
});

test("Expo native lane opens first when no bundle is mounted", () => {
  const plan = planPreviewReload({
    status: { framework: "expo", platform: "ios" },
    kind: "fast",
    bundleMounted: false,
  });
  assert.equal(plan?.lane, "native-hermes");
  assert.equal(plan?.mode, "fast");
  assert.equal(plan?.allowBundleFallback, true);
  assert.equal(plan?.shouldOpenNativeFirst, true);
});

test("busy reload returns no plan", () => {
  assert.equal(planPreviewReload({ reloadLoading: true }), null);
  assert.equal(planPreviewReload({ nativeLoading: true }), null);
});

test("failed browser reload is a line, not a reached target", () => {
  const result = {
    ok: false,
    mode: "fast" as const,
    reloadTarget: "none" as const,
    error: "No mobile SDK listener or browser bundle preview is connected on this agent.",
  };
  assert.equal(previewReloadReachedTarget(result), false);
  assert.equal(
    previewReloadFailureLine(result),
    "Reload failed: No mobile SDK listener or browser bundle preview is connected on this agent.",
  );
});


// ── Post-task render decisions ──────────────────────────────────────────────
//
// The two cases below are NEGATIVE CONTROLS: each reproduces a way the old
// code failed silently. If either ever returns `render` or an empty message,
// the "task finished and nothing happened, and nothing said why" bug is back.

test("browser lane offers a render by default", () => {
  const decision = planPostTaskRender({ lane: "browser", hasBrowserRenderer: true, taskStatus: "completed" });
  assert.equal(decision.action, "offer");
  assert.match(decision.message, /Render updates/);
});

test("browser lane renders when opted in", () => {
  assert.deepEqual(
    planPostTaskRender({ lane: "browser", hasBrowserRenderer: true, taskStatus: "completed", autoRenderEnabled: true }),
    { action: "render", lane: "browser" },
  );
});

test("browser lane also renders on review, not just completed", () => {
  assert.equal(
    planPostTaskRender({ lane: "browser", hasBrowserRenderer: true, taskStatus: "review", autoRenderEnabled: true }).action,
    "render",
  );
});

test("YOUR TURN (ready) offers its requested render instead of remaining queued", () => {
  const decision = planPostTaskRender({ lane: "browser", hasBrowserRenderer: true, taskStatus: "ready" });
  assert.equal(decision.action, "offer");
  assert.match(decision.message, /Render updates/);
});

test("mid-turn never renders — no surprise re-render while the user watches", () => {
  for (const status of ["queued", "running", undefined, null, ""]) {
    const d = planPostTaskRender({ lane: "browser", hasBrowserRenderer: true, taskStatus: status });
    assert.equal(d.action, "skip", `status ${String(status)} must not render`);
    assert.equal(d.reason, "not-terminal");
    assert.match(d.message, /^Preview refresh queued/);
  }
});

test("NEGATIVE CONTROL: a stale browser lane marker cannot claim it refreshed", () => {
  const d = planPostTaskRender({ lane: "browser", hasBrowserRenderer: false, taskStatus: "completed", autoRenderEnabled: true });
  assert.equal(d.action, "skip");
  assert.equal(d.reason, "browser-render-unavailable");
  assert.match(d.message, /Reopen it/);
});

test("NEGATIVE CONTROL: a browser-target WebRTC session skips WITH a reason", () => {
  // This is exactly Yaver-on-Yaver before the fix: the only offered lane was
  // WebRTC on a browser target, run-guest 400s for it, and the client returned
  // a bare `false`. The skip is fine; the SILENCE was the defect.
  const d = planPostTaskRender({
    lane: "webrtc",
    taskStatus: "completed",
    hasWebrtcSession: true,
    webrtcTargetCanRender: false,
    webrtcTargetLabel: "Chromium on the box",
  });
  assert.equal(d.action, "skip");
  assert.equal(d.reason, "target-cannot-render");
  assert.match(d.message, /Chromium on the box/);
  assert.ok(d.message.length > 20, "a skip must explain itself, not return a bare false");
});

test("NEGATIVE CONTROL: no open surface skips WITH a reason, never silently", () => {
  const d = planPostTaskRender({ lane: null, taskStatus: "completed" });
  assert.equal(d.action, "skip");
  assert.equal(d.reason, "no-active-surface");
  assert.ok(d.message.length > 20);
});

test("simulator WebRTC target still renders — the path that already worked", () => {
  assert.deepEqual(
    planPostTaskRender({
      lane: "webrtc",
      taskStatus: "completed",
      hasWebrtcSession: true,
      webrtcTargetCanRender: true,
      autoRenderEnabled: true,
    }),
    { action: "render", lane: "webrtc" },
  );
});

test("an in-flight refresh coalesces rather than stacking", () => {
  const d = planPostTaskRender({ lane: "browser", taskStatus: "completed", inFlight: true });
  assert.equal(d.action, "skip");
  assert.equal(d.reason, "already-in-flight");
});

test("every skip carries a non-empty message — totality", () => {
  const cases = [
    { lane: null, taskStatus: "completed" },
    { lane: "browser" as const, hasBrowserRenderer: true, taskStatus: "running" },
    { lane: "browser" as const, hasBrowserRenderer: true, taskStatus: "completed", inFlight: true },
    { lane: "browser" as const, hasBrowserRenderer: false, taskStatus: "completed" },
    { lane: "webrtc" as const, taskStatus: "completed", hasWebrtcSession: false },
    { lane: "webrtc" as const, taskStatus: "completed", hasWebrtcSession: true, webrtcTargetCanRender: false },
  ];
  for (const c of cases) {
    const d = planPostTaskRender(c as any);
    if (d.action === "skip") assert.ok(d.message.trim().length > 0, `empty message for ${JSON.stringify(c)}`);
  }
});
