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

test("Dogfood targets the primary and Production stays in native chrome", () => {
  assert.match(dogfood, /primaryOnly/);
  const webViewStart = /<WebView\s*\n/.exec(attached)?.index ?? -1;
  const production = attached.indexOf(">Production</Text>");
  assert.ok(production >= 0 && production < webViewStart, "Production escape must stay outside/before the WebView");
  assert.match(attached, /parseDogfoodRenderMessage/);
  assert.match(attached, /onMessage=/);
});
