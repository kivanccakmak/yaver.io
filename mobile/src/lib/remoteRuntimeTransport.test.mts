import assert from "node:assert/strict";
import test from "node:test";
import {
  initialRemoteRuntimeTransport,
  sameRemoteRuntimeWorkDir,
  shouldFallbackToRelayFrames,
} from "./remoteRuntimeTransport.ts";

test("relay signaling still attempts WebRTC media first", () => {
  assert.equal(initialRemoteRuntimeTransport(), "direct-webrtc");
});

test("relay snapshots are a bounded ICE failure fallback", () => {
  assert.equal(shouldFallbackToRelayFrames({
    relayAvailable: true,
    currentMode: "direct-webrtc",
    failureReason: "ice-failed",
    alreadyAttempted: false,
  }), true);
  assert.equal(shouldFallbackToRelayFrames({
    relayAvailable: true,
    currentMode: "direct-webrtc",
    failureReason: "blank-frames",
    alreadyAttempted: false,
  }), false);
  assert.equal(shouldFallbackToRelayFrames({
    relayAvailable: true,
    currentMode: "direct-webrtc",
    failureReason: "ice-failed",
    alreadyAttempted: true,
  }), false);
});

test("Windows work directories compare across slash and case variants", () => {
  assert.equal(sameRemoteRuntimeWorkDir("C:\\Users\\Friend\\App", "c:/users/friend/app/"), true);
  assert.equal(sameRemoteRuntimeWorkDir("/Users/Friend/App", "/Users/friend/App"), false);
});
