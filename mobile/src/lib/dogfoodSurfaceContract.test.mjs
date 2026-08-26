import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mobile = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const more = readFileSync(join(mobile, "app", "(tabs)", "more.tsx"), "utf8");
const dogfood = readFileSync(join(mobile, "app", "(tabs)", "dogfood.tsx"), "utf8");
const settings = readFileSync(join(mobile, "app", "(tabs)", "settings.tsx"), "utf8");
const attached = readFileSync(join(mobile, "app", "attach.tsx"), "utf8");
const rootLayout = readFileSync(join(mobile, "app", "_layout.tsx"), "utf8");
const gate = readFileSync(join(mobile, "src", "components", "AttachModeSection.tsx"), "utf8");
const launch = readFileSync(join(mobile, "app", "dogfood-launch.tsx"), "utf8");
const bubble = readFileSync(join(mobile, "src", "components", "BrowserVibeBubble.tsx"), "utf8");
const remoteRuntime = readFileSync(join(mobile, "app", "remote-runtime.tsx"), "utf8");

test("More removes the old Vibing row and exposes contributor Dogfood to everyone", () => {
  assert.doesNotMatch(more, /accessibilityLabel="Open Vibing"|>Vibing<|navigate\("\/vibing"/);
  assert.match(more, /Develop Yaver/);
  assert.match(more, /\(tabs\)\/dogfood/);
  assert.doesNotMatch(more, /isOwner\s*\?\s*\([\s\S]{0,500}Dogfood/);
});

test("Dogfood is a signed-in contributor workflow, not a product-owner entitlement", () => {
  assert.doesNotMatch(dogfood, /user\?\.isOwner|Owner access only|owner account/);
  assert.match(dogfood, /<AttachModeSection c=\{c\}/);
  assert.match(dogfood, /canonical main branch is protected/);
  assert.doesNotMatch(settings, /AttachModeSection/);
  assert.doesNotMatch(rootLayout, /DogfoodCaptureHost|loadDogfoodMode/,
    "the retired screenshot catcher would silently keep the old meaning alive");
});

test("Dogfood can switch same-account devices and its native escape stays outside the WebView", () => {
  assert.match(gate, /devices\.map/);
  assert.match(gate, /selectDevice\(device\)/);
  const match = /<WebView\s*\n/.exec(attached);
  assert.ok(match, "the Dogfood host must render its browser lane");
  const webViewEnd = attached.indexOf("/>", match.index);
  const webView = attached.slice(match.index, webViewEnd);
  assert.doesNotMatch(webView, /confirmDetach|Exit Dogfood mode/);
  assert.match(attached.replace(webView, ""), /<BrowserVibeBubble/);
  assert.match(attached.replace(webView, ""), /onExitPreview=\{confirmDetach\}/);
  assert.doesNotMatch(attached, /styles\.chrome|Dogfood mode<\/Text>/,
    "Dogfood should look like the real app, not an app inside a persistent host navigation bar");
  assert.match(attached, /reloadDogfoodSurface\("manual"\)/);
  assert.match(attached, /DOGFOOD_WEBVIEW_LOAD_FAILED/,
    "an in-mode browser failure must carry a stable code, not only prose");
  assert.match(attached, /onHttpError=/);
  assert.match(attached, /DOGFOOD_WEBVIEW_HTTP_FAILED/,
    "HTTP failures must not paint a raw server error as if Dogfood succeeded");
  assert.match(attached, /parseDogfoodRenderMessage/);
  assert.match(attached, /onMessage=/);
});

test("Dogfood entry is fail-closed until Expo and the browser lane are proved", () => {
  const attachClient = readFileSync(join(mobile, "src", "lib", "attachClient.ts"), "utf8");
  assert.match(attachClient, /prepareDogfoodMode/);
  assert.match(attachClient, /doctorBrowserLane\(client, 45\)/);
  assert.match(attachClient, /await stopAttachSession\(deviceId, session\.sessionId\)/,
    "a failed entry must revoke the partially minted capability");
  assert.match(attachClient, /DOGFOOD_PRIMARY_DISCONNECTED/);
  assert.match(attachClient, /resolveAgentPreviewUrl\(client\.baseUrl, bundlePath\)/,
    "the agent's relative browser path must retain the selected device's relay prefix");
  assert.match(attachClient, /probeAgentPreviewRoute\(url, client\.getAuthHeaders\(\)\)/,
    "Dogfood must probe the exact phone handoff URL instead of trusting only the box-local doctor");
  assert.match(attachClient, /DOGFOOD_RENDER_ROUTE_/,
    "a failed handoff route must stop entry with a stable code");
  assert.doesNotMatch(attachClient, /getDevServerBundleUrl\(bundlePath\)/,
    "Dogfood must not copy the owner bearer into a WebView URL");
});

test("Dogfood exposes the shared three-lane matrix with browser as the default", () => {
  assert.match(gate, /dogfoodLaneOptions\("expo"/);
  assert.match(gate, /useState<DogfoodLane>\("browser"\)/);
  assert.match(gate, /option\.label/);
  assert.match(launch, /lane === "hermes"/);
  assert.match(launch, /startDogfoodHermesLane/);
  assert.match(launch, /lane === "webrtc"/);
  assert.doesNotMatch(launch, /DOGFOOD_SELF_HERMES_UNSAFE/);
  assert.match(launch, /prepareDogfoodMode/,
    "browser Dogfood must retain the proved attach/browser implementation");
  assert.match(launch, /pathname: "\/remote-runtime"/,
    "WebRTC Dogfood must reuse the Projects native runtime surface");
  assert.match(attached, /<BrowserVibeBubble/,
    "browser Dogfood must expose Vibing and routing on the live surface");
  assert.match(remoteRuntime, /<BrowserVibeBubble/,
    "WebRTC Dogfood must expose Vibing and routing on the live surface");
  assert.match(bubble, /testID="browser-vibe-fast-reload"/,
    "Fast Reload must sit beside Vibing instead of inside Settings");
});
