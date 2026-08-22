/**
 * Cross-surface guard for the browser-window WebRTC incident (2026-08-22).
 * Run: node scripts/remote-runtime-surface-parity.test.mjs
 *
 * The broken mobile path created the remote-runtime session before starting
 * Expo Web, accepted about:blank as its first frame, and omitted viewer
 * identity. TV already had all three protections. These assertions deliberately
 * read the independently compiled clients so Metro/Next/Swift drift is caught.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), "utf8");

const mobileClient = read("mobile/src/lib/quic.ts");
const mobileViewer = read("mobile/app/remote-runtime.tsx");
const webClient = read("web/lib/agent-client.ts");
const webViewer = read("web/components/dashboard/RemoteRuntimeViewer.tsx");
const spatialViewer = read("web/app/spatial/vr/RemoteWindow3D.tsx");
const tvViewer = read("tvos/YaverTV/Views/RemoteRuntimeWebRTCView.swift");
const agentFrames = read("desktop/agent/remote_runtime_webrtc.go");

for (const [name, source] of [["mobile", mobileClient], ["web/desktop", webClient]]) {
  assert.match(source, /targetId === "browser-window"[\s\S]{0,160}prepareRemoteRuntimeBrowserLane/, `${name} must prepare before session creation`);
  assert.match(source, /clientId[\s\S]{0,100}surface:/, `${name} must attribute its viewer`);
  assert.match(source, /waiting-for-dev-server/, `${name} must preserve named create failures`);
}

assert.match(tvViewer, /prepareBrowserLaneIfNeeded/, "TV/visionOS contract must retain browser preparation");
assert.doesNotMatch(mobileViewer, /\bvideo\.addEventListener/, "mobile RTP handler must use the wired videoEl surface");
for (const [name, source] of [["mobile", mobileViewer], ["web/desktop", webViewer], ["spatial VR", spatialViewer]]) {
  assert.match(source, /max - min <= 6/, `${name} must reject uniform black/white frames`);
  assert.match(source, /8_000|8000/, `${name} must bound blank-frame waiting`);
}
assert.match(agentFrames, /remoteRuntimeFrameBlockReason/, "agent must not turn an unprepared browser frame into streaming success");

console.log("ok remote-runtime preparation, identity, failure, and blank-frame parity across mobile/web/desktop/TV/visionOS/spatial VR");
