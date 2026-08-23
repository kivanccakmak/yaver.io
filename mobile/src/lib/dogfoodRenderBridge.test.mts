import assert from "node:assert/strict";
import test from "node:test";
import {
  DOGFOOD_RENDER_MESSAGE,
  isAttachedDogfoodWebRuntime,
  makeDogfoodRenderMessage,
  parseDogfoodRenderMessage,
} from "./dogfoodRenderBridge.ts";

test("dogfood render messages round-trip without carrying authority", () => {
  assert.deepEqual(parseDogfoodRenderMessage(makeDogfoodRenderMessage("task-1")), {
    type: DOGFOOD_RENDER_MESSAGE,
    source: "task-1",
  });
  assert.equal(parseDogfoodRenderMessage('{"type":"something-else"}'), null);
  assert.equal(parseDogfoodRenderMessage("not-json"), null);
});

test("only an attached WebView runtime may use the bridge", () => {
  const postMessage = () => {};
  assert.equal(isAttachedDogfoodWebRuntime({
    localStorage: { getItem: () => "1" },
    ReactNativeWebView: { postMessage },
  }), true);
  assert.equal(isAttachedDogfoodWebRuntime({
    localStorage: { getItem: () => null },
    ReactNativeWebView: { postMessage },
  }), false);
  assert.equal(isAttachedDogfoodWebRuntime({ localStorage: { getItem: () => "1" } }), false);
});
