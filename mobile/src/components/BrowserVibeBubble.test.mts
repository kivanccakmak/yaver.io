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
  assert.ok(source.includes('open ? "−" : "Y"'));
});

test("the bubble separates Chat and Settings without unmounting the task", () => {
  assert.ok(source.includes("<StudioChatPane"), "bubble does not reuse the Vibing conversation");
  assert.match(source, /<StudioChatPane[\s\S]*?\bcompact\b/, "bubble still exposes Studio inventory instead of chat only");
  assert.ok(source.includes('!open && styles.hidden'), "closing the bubble unmounts and loses the active task session");
  assert.ok(!source.includes("DomInspect"));
  assert.ok(!source.includes("ScreenContext"));
  assert.ok(!source.includes("Report Bug"));
  assert.ok(source.includes('testID="browser-vibe-tabs"'));
  assert.ok(source.includes('activeTab !== "chat" && styles.hidden'));
  assert.ok(chat.includes("taskClient.executeVibingSuggestion"));
  assert.ok(chat.includes("taskClient.continueTask(activeTask.id, text)"));
});

test("browser Vibing mirrors feedback controls and remains mounted when minimized", () => {
  assert.ok(source.includes("KeyboardAvoidingView"), "composer can still be covered by the iOS keyboard");
  assert.ok(source.includes('accessibilityLabel="Minimize Vibing"'));
  assert.ok(source.includes('accessibilityLabel="Exit preview and return to Yaver"'));
  assert.ok(source.includes('testID="browser-vibe-runner-picker"'));
  assert.ok(source.includes('testID="browser-vibe-machine-routing"'));
  assert.ok(source.includes("setPrimaryRunnerForDevice"), "runner/model picker does not persist its visible choice");
  assert.ok(source.includes('!open && styles.hidden'), "minimizing unmounts the live task instead of backgrounding it");
  assert.ok(source.includes('testID="browser-vibe-fast-reload"'), "fast reload is not beside the floating Vibing control");
  assert.ok(source.includes('reload("fast")'), "fast reload is missing from the preview overlay");
  assert.ok(!source.includes("Hot Reload"), "lower-frequency reload controls still crowd Settings");
  assert.ok(source.includes("Reload queued until coding finishes"), "reload executes over an active coding turn instead of queueing");
  assert.ok(source.includes("onTaskStateChange={setActiveTask}"), "preview host cannot distinguish coding from idle");
  assert.ok(source.includes('testID="browser-vibe-machine-failure"'), "machine disconnect has no visible route to recovery");
  assert.ok(source.includes('testID="browser-vibe-runner-failure"'), "no-ready-runner state has no visible route to setup");
  assert.ok(source.includes("<RunnerAuthModal"), "runner deauthentication has no in-place sign-in route");
  assert.ok(source.includes("<OpenCodeConfigModal"), "OpenCode failure has no in-place configuration route");
  assert.ok(source.includes("codingClient.installRunner"), "missing runner has no streamed install route");
  assert.ok(source.includes('reloaded === false'), "reload failure can still be reported as success");
  assert.ok(preview.includes("onExitPreview={() => setShowPreview(false)}"));
  assert.ok(projects.includes("onExitPreview={() => setShowWebView(false)}"));
});

test("Settings uses two progressive-disclosure cards and Chat stays focused", () => {
  assert.ok(source.includes("machineChoicesOpen"));
  assert.ok(source.includes("runnerChoicesOpen"));
  assert.ok(source.includes('type MachineRole = "runner" | "render"'));
  assert.ok(source.includes("visibleMachineRole"));
  assert.ok(!source.includes("routeSummary"), "Chat repeats routing already available in Settings");
  assert.ok(!chat.includes("Type a vibe prompt"), "Chat repeats runner/model guidance already available in Settings");
});

test("coding and rendering machines are independent routes", () => {
  assert.ok(source.includes('machineRoles?.runnerDeviceId'));
  assert.ok(source.includes('machineRoles?.renderDeviceId'));
  assert.ok(source.includes('role === "runner" ? nextDeviceId'));
  assert.ok(source.includes('role === "render" ? nextDeviceId'));
  assert.ok(source.includes("saveMachineRole(visibleMachineRole, device.id)"));
  assert.ok(source.includes('client={codingClient}'));
  assert.ok(preview.includes('connectionManager.renderClient()'));
  assert.ok(projects.includes('connectionManager.renderClient()'));
  assert.ok(projects.includes('connectionManager.runnerClient()'));
});

test("the visible runner and model are pinned onto the task request", () => {
  assert.ok(source.includes("runner={selectedRunnerId || savedRunner || undefined}"));
  assert.ok(source.includes("model={selectedModelId || savedModel || undefined}"));
  assert.ok(chat.includes("projectName,"));
  assert.ok(chat.includes("runner,"));
  assert.ok(chat.includes("model,"));
});
