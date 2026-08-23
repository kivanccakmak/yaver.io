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

test("More removes the Vibing row and exposes Dogfood only behind isOwner", () => {
  assert.doesNotMatch(more, /accessibilityLabel="Open Vibing"|>Vibing<|navigate\("\/vibing"/);
  const ownerBlock = more.slice(more.indexOf("{isOwner ? ("), more.indexOf("{isOwner ? (") + 1500);
  assert.match(ownerBlock, /Dogfood mode/);
  assert.match(ownerBlock, /\(tabs\)\/dogfood/);
});

test("a guessed Dogfood route still fails closed for a non-owner", () => {
  assert.match(dogfood, /user\?\.isOwner === true/);
  assert.match(dogfood, /Owner access only/);
  assert.doesNotMatch(settings, /AttachModeSection/);
  assert.doesNotMatch(rootLayout, /DogfoodCaptureHost|loadDogfoodMode/,
    "the retired screenshot catcher would silently keep the old meaning alive");
});

test("Dogfood targets the primary and its native escape stays outside the WebView", () => {
  assert.match(dogfood, /primaryOnly/);
  const match = /<WebView\s*\n/.exec(attached);
  assert.ok(match, "the Dogfood host must render its browser lane");
  const webViewEnd = attached.indexOf("/>", match.index);
  const webView = attached.slice(match.index, webViewEnd);
  assert.doesNotMatch(webView, /confirmDetach|Exit Dogfood mode/);
  assert.match(attached.replace(webView, ""), /accessibilityLabel="Exit Dogfood mode and switch to Production"/);
  assert.doesNotMatch(attached, /styles\.chrome|Dogfood mode<\/Text>/,
    "Dogfood should look like the real app, not an app inside a persistent host navigation bar");
  assert.match(attached, /accessibilityLabel="Re-render Yaver"/);
  assert.match(attached, /reloadDogfoodSurface\("manual"\)/);
  assert.match(attached, /DOGFOOD_WEBVIEW_LOAD_FAILED/,
    "an in-mode browser failure must carry a stable code, not only prose");
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
  assert.match(attachClient, /const agentOrigin = client\.baseUrl/);
  assert.match(attachClient, /new URL\(bundlePath, agentOrigin\)/,
    "the agent's relative browser path must resolve through the selected primary device");
  assert.doesNotMatch(attachClient, /getDevServerBundleUrl\(bundlePath\)/,
    "Dogfood must not copy the owner bearer into a WebView URL");
});
