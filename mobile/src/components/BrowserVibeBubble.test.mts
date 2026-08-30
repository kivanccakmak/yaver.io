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
  assert.ok(chat.includes("if (!full)"), "a retained console replay can still resurrect a completed task");
  assert.ok(chat.includes("mergeTaskSnapshot"), "Vibing has no independent authoritative task reconciliation");
  assert.ok(chat.includes("planStreamRecovery"), "Vibing still drops a broken task stream silently");
  assert.ok(chat.includes('accessibilityLabel="Reattach live output"'), "a lost live stream has no in-place recovery route");
  assert.ok(chat.includes("tasks.length > 1"), "topic cards still occupy an empty or single chat");
  assert.ok(chat.includes("tasks.length === 1"), "one saved topic has no compact single-chat controls");
  assert.ok(chat.includes("draftingNewTopicRef"), "the single topic auto-restore prevents creating a second topic");
});

test("Reload Only is a reload-and-exit surface with no chat work", () => {
  assert.ok(source.includes('usageMode === "reload-only" ? ('));
  assert.ok(source.includes('testID="browser-reload-only-panel"'));
  assert.ok(source.includes('>Full Reload</Text>'));
  assert.ok(source.includes('>Back to Yaver</Text>'));
  assert.ok(source.includes('if (!open || usageMode === "reload-only") return;'),
    "Reload Only still fetches runner inventory");
  const reloadBranch = source.slice(
    source.indexOf('{usageMode === "reload-only" ? ('),
    source.indexOf(') : <>', source.indexOf('{usageMode === "reload-only" ? (')),
  );
  assert.ok(!reloadBranch.includes('<StudioChatPane'), "Reload Only renders chat");
});

test("browser Vibing mirrors feedback controls and remains mounted when minimized", () => {
  assert.ok(source.includes("KeyboardAvoidingView"), "composer can still be covered by the iOS keyboard");
  assert.ok(source.includes('usageMode === "reload-only" ? "Minimize Reload controls" : "Minimize Vibing"'));
  assert.ok(source.includes('accessibilityLabel="Exit preview and return to Yaver"'));
  assert.ok(source.includes('testID={`browser-vibe-${role}-machine`}'));
  assert.ok(source.includes("setPrimaryRunnerForDevice"), "runner/model picker does not persist its visible choice");
  assert.ok(source.includes('!open && styles.hidden'), "minimizing unmounts the live task instead of backgrounding it");
  assert.ok(source.includes('testID="browser-vibe-fast-reload"'), "fast reload is not beside the floating Vibing control");
  assert.ok(source.includes('reload("fast")'), "fast reload is missing from the preview overlay");
  assert.ok(!source.includes("Hot Reload"), "lower-frequency reload controls still crowd Settings");
  assert.ok(source.includes("Reload queued until coding finishes"), "reload executes over an active coding turn instead of queueing");
  assert.ok(source.includes("onTaskStateChange={setActiveTask}"), "preview host cannot distinguish coding from idle");
  assert.ok(source.includes('testID="browser-vibe-machine-failure"'), "machine disconnect has no visible route to recovery");
  assert.ok(source.includes("codingClient.getRunners()"), "the machine failure is still inferred without probing the Vibing API");
  assert.ok(source.includes('codingProbeState === "unreachable"'), "a transient pool badge can still declare the machine offline");
  assert.ok(source.includes("retryCodingConnection"), "the SFMG preview has no in-place connection retry");
  assert.ok(source.includes(">Retry Connection<"), "the connection route still exits the working preview");
  assert.ok(!source.includes("Exit Preview &amp; Reconnect"), "connection recovery still destroys the last good preview");
  assert.ok(source.includes('testID="browser-vibe-runner-failure"'), "no-ready-runner state has no visible route to setup");
  assert.ok(source.includes("<RunnerAuthModal"), "runner deauthentication has no in-place sign-in route");
  assert.ok(source.includes("<OpenCodeConfigModal"), "OpenCode failure has no in-place configuration route");
  assert.ok(source.includes("codingClient.installRunner"), "missing runner has no streamed install route");
  assert.ok(source.includes('reloaded === false'), "reload failure can still be reported as success");
  assert.ok(preview.includes("onExitPreview={() => setShowPreview(false)}"));
  assert.ok(projects.includes("onExitPreview={() => setShowWebView(false)}"));
});

test("the Y, Fast Reload, and contextual exception Fix controls share one bounded dock", () => {
  assert.ok(source.includes("PanResponder.create"), "the dogfood controls have no drag responder");
  assert.ok(source.includes('testID="browser-vibe-dock"'), "the controls are not grouped into one dock");
  assert.ok(source.includes("...dockPanResponder.panHandlers"), "the dock does not receive drag gestures");
  assert.ok(source.includes("clampFloatingDockPosition"), "dragging can strand the dock beyond the viewport");
  const dock = source.slice(source.indexOf('testID="browser-vibe-dock"'));
  assert.ok(dock.indexOf('testID="browser-vibe-fast-reload"') >= 0, "Fast Reload is outside the draggable dock");
  assert.ok(dock.indexOf('testID="browser-vibe-fix-exception"') >= 0, "exception Fix is outside the draggable dock");
  assert.ok(source.includes("onFixException ?"), "Fix is shown even when no exception was captured");
  assert.ok(dock.indexOf('testID="browser-vibe-bubble"') >= 0, "the Y control is outside the draggable dock");
  assert.ok(source.includes("{!open ? <Animated.View"),
    "the floating dock still covers the composer after Vibing opens");
});

test("Settings gives runner and render machines direct cards and Chat stays focused", () => {
  assert.ok(source.includes("machineChoicesOpen"));
  assert.ok(source.includes('type MachineRole = "runner" | "render"'));
  assert.ok(source.includes('testID={`browser-vibe-${role}-machine`}'));
  assert.ok(source.includes('saveMachineRole(role, device.id)'));
  assert.ok(source.includes('accessibilityLabel={`${choicesOpen ? "Hide" : "Choose"} ${role} settings`}'),
    "the machine card itself is not the picker action");
  assert.ok(source.includes('choicesOpen && role === "runner"'),
    "the Runner card does not own runner and model selection");
  assert.ok(source.includes("if (machineChoicesOpen && !choicesOpen) return null"),
    "opening one settings card still leaves the other card crowding its editor");
  assert.ok(!source.includes('testID="browser-vibe-runner-picker"'),
    "runner selection remains a third card instead of living in Runner settings");
  assert.ok(!source.includes("runnerChoicesOpen"), "runner selection still requires a second disclosure tap");
  assert.ok(source.includes('setMachineChoicesOpen("runner")'),
    "Open Runner Setup stops at Settings instead of opening the focused Runner card");
  assert.ok(!source.includes("Render machine disconnected · choose a connected renderer"),
    "render status still occupies a separate warning instead of its actionable card");
  assert.ok(!source.includes("visibleMachineRole"), "Settings still requires switching a shared Device card between roles");
  assert.ok(!source.includes("styles.roleTabs"), "Runner and Render are still nested tabs instead of direct cards");
  assert.ok(!source.includes("routeSummary"), "Chat repeats routing already available in Settings");
  assert.ok(!chat.includes("Type a vibe prompt"), "Chat repeats runner/model guidance already available in Settings");
});

test("runner and render machine choosers use the phone's vertical space", () => {
  assert.ok(source.includes("<View style={styles.machineList}>"));
  assert.match(source, /machineChoice:\s*\{\s*width:\s*"100%"/);
  assert.ok(source.includes("machineChoiceState"));
  assert.ok(source.includes("accessibilityState={{ selected: device.id === roleDeviceId, disabled: isCoding }}"));
});

test("coding and rendering machines are independent routes", () => {
  assert.ok(source.includes('machineRoles?.runnerDeviceId'));
  assert.ok(source.includes('machineRoles?.renderDeviceId'));
  assert.ok(source.includes('role === "runner" ? nextDeviceId'));
  assert.ok(source.includes('role === "render" ? nextDeviceId'));
  assert.ok(source.includes("saveMachineRole(role, device.id)"));
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
