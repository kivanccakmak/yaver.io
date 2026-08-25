import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "BrowserVibeBubble.tsx"), "utf8");
const preview = readFileSync(join(here, "DevPreview.tsx"), "utf8");
const projects = readFileSync(join(here, "../../app/(tabs)/apps.tsx"), "utf8");
const chat = readFileSync(join(here, "studio/StudioChatPane.tsx"), "utf8");

test("browser lane has no host navigation or tools and mounts one Y bubble", () => {
  assert.match(preview, /\{mustUseNativePreview \? \(\s*<View style=\{\[styles\.header/);
  assert.ok(!preview.includes('testID="preview-tools-more"'));
  assert.ok(!preview.includes("<DomInspectChip"));
  assert.equal(preview.split("<BrowserVibeBubble").length - 1, 1);
  assert.equal(projects.split("<BrowserVibeBubble").length - 1, 1);
  assert.ok(!projects.includes("handlePreviewDomMessage"));
  const browserModal = projects.slice(projects.indexOf("{/* Full-screen WebView */}"));
  assert.ok(!browserModal.includes("<AppScreenHeader"), "Projects browser lane still renders top navigation");
  assert.ok(source.includes('testID="browser-vibe-bubble"'));
  assert.ok(source.includes('>Y</Text>') || source.includes('open ? "×" : "Y"'));
});

test("the bubble opens only Vibing chat with same-task follow-ups", () => {
  assert.ok(source.includes("<StudioChatPane"), "bubble does not reuse the Vibing conversation");
  assert.ok(source.includes("<StudioChatPane compact"), "bubble still exposes Studio inventory instead of chat only");
  assert.ok(source.includes('!open && styles.hidden'), "closing the bubble unmounts and loses the active task session");
  assert.ok(!source.includes("DomInspect"));
  assert.ok(!source.includes("ScreenContext"));
  assert.ok(!source.includes("Hot Reload"));
  assert.ok(!source.includes("Report Bug"));
  assert.ok(chat.includes("quicClient.executeVibingSuggestion"));
  assert.ok(chat.includes("quicClient.continueTask(activeTask.id, text)"));
});
