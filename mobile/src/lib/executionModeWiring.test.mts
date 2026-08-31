import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("local-only is a real transport boundary, not a presentation flag", async () => {
  const source = await read("../context/DeviceContext.tsx");
  assert.match(source, /allowsRemoteAutoConnect\(codingMode\)/);
  assert.match(source, /autoConnectCancelRef\.current = true/);
  assert.match(source, /connectionManager\.disconnectAll\(\)/);
  assert.match(source, /allowsRemoteAutoConnect\(codingModeRef\.current\)/);
});

test("No remote box is selectable from every requested entry point", async () => {
  const [picker, devices, settings] = await Promise.all([
    read("../components/RemoteBoxPickerModal.tsx"),
    read("../../app/(tabs)/devices.tsx"),
    read("../../app/(tabs)/settings.tsx"),
  ]);
  for (const source of [picker, devices, settings]) {
    assert.match(source, /No remote box/);
    assert.match(source, /setCodingMode\("local-only"\)|setCodingMode\(codingMode === "local-only"/);
  }
  assert.match(devices, /user\?\.isOwner === true/);
  assert.match(devices, /testID="devices-remoteless-card"/);
  assert.match(devices, /borderStyle: "dashed"/);
  assert.match(devices, /REMOTELESS · OWNER PREVIEW/);
});

test("phone-local Tasks require a phone checkout and use explicit placement", async () => {
  const source = await read("../../app/(tabs)/tasks.tsx");
  assert.match(source, /forceLocal: codingMode === "local-only"/);
  assert.match(source, /codingMode === "local-only" && !selectedPhoneCheckout/);
  assert.match(source, /askModeEnabled \? "audit" : "vibe"/);
  assert.match(source, /const consumeAskMode = useCallback\(\(\) => {\s*setAskModeEnabled\(false\);/);
  assert.match(source, /consumeAskMode\(\);\s*\n\s*pendingOpenTaskRef\.current = initialTask/);
  assert.match(source, /setFollowUpText\(""\);\s*\n\s*setFollowUpImages\(\[\]\);\s*\n\s*consumeAskMode\(\);/);
  assert.match(source, /const isLocalFollowUp = isPhoneLocalTask\(selectedTask\) \|\| selectedTask\.runnerId === "yaver-agent"/);
  assert.match(source, /isPhoneLocalTask\(task\)/);
  assert.match(source, /SandboxGitPanel/);
  assert.match(source, /Review &amp; deliver/);
  assert.match(source, /canComposeWithRemoteless/);
  assert.match(source, /ownerRemotelessEnabled && phoneProjects\.length/);
  assert.match(source, /taskExecutionPlacement\.lane === "blocked"/);
  assert.match(source, /Images need a remote box/);
  assert.match(source, /endRemotelessTask\(taskId, "stopped"/);
});

test("DeepSeek can be configured from the backend screen that advertises it", async () => {
  const source = await read("../../app/sandbox-ai.tsx");
  assert.match(source, /deepseek: LOCAL_KEYS\.deepseekApiKey/);
  assert.match(source, /\["deepseek", "anthropic", "openai", "glm"\]/);
  assert.match(source, /av\.deepseekKey/);
});

test("Projects reads phone checkouts and connected Git providers without a box", async () => {
  const source = await read("../../app/(tabs)/projects.tsx");
  assert.match(source, /listLocalPhoneProjectsMeta/);
  assert.match(source, /discoverConnectedProviderProjects/);
  assert.match(source, /cloneGitRepoToPhone/);
  assert.match(source, /codingMode === "local-only"/);
});

test("failed clones cannot overwrite or strand a phone project", async () => {
  const source = await read("./cloneToPhone.ts");
  assert.match(source, /listLocalPhoneProjectsMeta/);
  assert.match(source, /already exists on this phone/);
  assert.match(source, /deleteLocalPhoneProject\(slug\)/);
});
