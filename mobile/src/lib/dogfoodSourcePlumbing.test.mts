import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const mobileRoot = path.resolve(import.meta.dirname, "../..");
const repoRoot = path.resolve(mobileRoot, "..");

test("Dogfood source truth is produced by the Go agent and consumed by mobile", () => {
  const server = fs.readFileSync(path.join(repoRoot, "desktop/agent/httpserver.go"), "utf8");
  const runtime = fs.readFileSync(path.join(repoRoot, "desktop/agent/dogfood_runtime.go"), "utf8");
  const client = fs.readFileSync(path.join(mobileRoot, "src/lib/quic.ts"), "utf8");

  assert.match(server, /HandleFunc\("\/dogfood\/source\/status", s\.auth\(s\.handleDogfoodSourceStatus\)\)/);
  assert.match(runtime, /DOGFOOD_SOURCE_MISSING/);
  assert.match(runtime, /DOGFOOD_GIT_NOT_INSTALLED/);
  assert.match(runtime, /DOGFOOD_GIT_AUTH_UNCONFIGURED/);
  assert.match(runtime, /DOGFOOD_GIT_CREDENTIALS_EMBEDDED/);
  assert.match(runtime, /https:\/\/github\.com\/yaver-io\/yaver\.io\.git/);
  assert.match(runtime, /Candidates\s+\[\]dogfoodCheckoutCandidate/);
  assert.match(runtime, /findDogfoodCheckouts\(agentWorkDir\)/);
  assert.match(runtime, /runGit\(seed, "rev-parse", "--show-toplevel"\)/,
    "the configured work directory must be resolved before a HOME scan");
  assert.match(runtime, /os\.IsNotExist\(statErr\)/,
    "a foreign path must trigger discovery on the selected box");
  assert.doesNotMatch(runtime, /HasSuffix\(normalized, "github\.com/,
    "canonical remotes must parse the host instead of trusting a suffix");
  assert.match(client, /peerEndpoint\(target, `\/dogfood\/source\/status\$\{query\}`\)/);
  assert.match(client, /candidates: Array\.isArray\(data\?\.candidates\)/);
  assert.doesNotMatch(client, /github\.com\/kivanccakmak\/yaver\.io\.git/);
});

test("Dogfood discovery is not blocked by preference or advisory onboarding reads", () => {
  const section = fs.readFileSync(path.join(mobileRoot, "src/components/AttachModeSection.tsx"), "utf8");
  const store = fs.readFileSync(path.join(mobileRoot, "src/lib/boxInitStore.ts"), "utf8");

  assert.match(section, /setCheckoutDeviceId\(deviceId\);[\s\S]*AsyncStorage\.getItem/,
    "device-owned discovery must start before the cached path resolves");
  assert.doesNotMatch(section, /if \(!configLoaded \|\| !targetConnected/,
    "lane preferences must not gate source discovery");
  assert.match(store, /Promise\.race\([\s\S]*machineOnboardingStatus/,
    "advisory provider inventory must have a wall-clock bound");
});

test("resolved Dogfood paths propagate through prepare, render, and reload", () => {
  const attachClient = fs.readFileSync(path.join(mobileRoot, "src/lib/attachClient.ts"), "utf8");
  const overlay = fs.readFileSync(path.join(mobileRoot, "src/context/DogfoodOverlayContext.tsx"), "utf8");

  assert.match(attachClient, /workDir: resolvedWorkDir/);
  assert.match(attachClient, /startAttachSession\(deviceId, resolvedWorkDir\)/);
  assert.match(attachClient, /startYaverBrowserLane\(deviceId, resolvedWorkDir\)/);
  assert.match(overlay, /startDogfoodHermesLane\(next\.deviceId, prepared\.workDir\)/);
  assert.match(overlay, /reloadAttachedDogfoodBrowserLane\(activeRequest\.deviceId, workDir, kind\)/);
  assert.match(overlay, /metadata: \{ workDir: result\.workDir/);
  assert.match(overlay, /projectPath=\{overlayWorkDir\}/);
});

test("mobile routes missing source and Git failures to deterministic fixes", () => {
  const section = fs.readFileSync(path.join(mobileRoot, "src/components/AttachModeSection.tsx"), "utf8");
  const settings = fs.readFileSync(path.join(mobileRoot, "app/(tabs)/settings.tsx"), "utf8");

  assert.match(section, /installDogfoodGit/);
  assert.match(section, /installDogfoodSource/);
  assert.match(section, /Looking for a Yaver checkout/);
  assert.match(section, /checkoutCandidates\.map/);
  assert.match(section, /Configure Git on this box/);
  assert.match(section, /gitWizard: "1", deviceId: targetDevice\.id/);
  assert.match(settings, /gitWizardParam/);
  assert.match(settings, /setSelectedOnboardingTargetIds\(\[gitWizardDeviceParam\]\)/);
  assert.match(settings, /gitOnboardingSectionY\.current/);
});

test("Dogfood keeps machine, runner, checkout, and runtime as compact ordered rows", () => {
  const section = fs.readFileSync(path.join(mobileRoot, "src/components/AttachModeSection.tsx"), "utf8");

  assert.match(section, /type AttachPanelKey = AttachStep\["key"\] \| "lane"/);
  assert.match(section, /useState<AttachPanelKey \| null>\(null\)/);
  assert.match(section, /desktop-outline/);
  assert.match(section, /sparkles-outline/);
  assert.match(section, /folder-open-outline/);
  assert.match(section, /layers-outline/);
  assert.match(section, /expandedStep === "box"/);
  assert.match(section, /expandedStep === "runner"/);
  assert.match(section, /expandedStep === "checkout"/);
  assert.match(section, /expandedStep === "lane"/);
  assert.match(section, /step\.status === "ok" \? "Change" : "Set up"/);
  assert.match(section, /accessibilityLabel="Box choices"/);
  assert.match(section, /accessibilityLabel="Runner choices"/);
  assert.match(section, /accessibilityLabel="Yaver checkout choices"/);
  assert.match(section, /accessibilityLabel="Find Yaver checkout on this box"/,
    "checkout repair must be an explicit action, never an unexpected tap side effect");
  assert.doesNotMatch(section, /step\.key === "checkout" && step\.status !== "ok"/,
    "opening Checkout must expose its choices instead of immediately cloning or mutating a box");
  assert.match(section, /accessibilityLabel="Runtime lane choices"/);
  assert.match(section, /<Modal[\s\S]*?visible/,
    "a settings row must open its choices where the user can see them, not below unrelated controls");
  assert.match(section, /<ScrollView[\s\S]*?keyboardShouldPersistTaps="handled"/,
    "long checkout or runner choices must remain reachable on a phone");
  assert.match(section, /accessibilityLabel="Close Dogfood setting choices"/);
  assert.match(section, /Pair remote box/);
  assert.match(section, /openPair: "1", returnTo: "dogfood"/);
});
