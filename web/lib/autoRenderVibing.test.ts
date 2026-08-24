import assert from "node:assert/strict";
import test from "node:test";
import { autoRenderVibingFromSettings, isExplicitRenderPrompt } from "./autoRenderVibingPolicy";

test("auto-render defaults off and requires an explicit true", () => {
  assert.equal(autoRenderVibingFromSettings(null), false);
  assert.equal(autoRenderVibingFromSettings({}), false);
  assert.equal(autoRenderVibingFromSettings({ autoRenderVibing: false }), false);
  assert.equal(autoRenderVibingFromSettings({ autoRenderVibing: "true" }), false);
  assert.equal(autoRenderVibingFromSettings({ autoRenderVibing: true }), true);
});

test("only whole-message render commands bypass coding", () => {
  assert.equal(isExplicitRenderPrompt("re-render"), true);
  assert.equal(isExplicitRenderPrompt("please fast reload the preview"), true);
  assert.equal(isExplicitRenderPrompt("fix the reload bug"), false);
  assert.equal(isExplicitRenderPrompt("change the UI and render again"), false);
});
