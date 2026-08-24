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
  assert.match(client, /peerEndpoint\(target, `\/dogfood\/source\/status\$\{query\}`\)/);
  assert.doesNotMatch(client, /github\.com\/kivanccakmak\/yaver\.io\.git/);
});

test("mobile routes missing source and Git failures to deterministic fixes", () => {
  const section = fs.readFileSync(path.join(mobileRoot, "src/components/AttachModeSection.tsx"), "utf8");
  const settings = fs.readFileSync(path.join(mobileRoot, "app/(tabs)/settings.tsx"), "utf8");

  assert.match(section, /installDogfoodGit/);
  assert.match(section, /installDogfoodSource/);
  assert.match(section, /Configure Git on this box/);
  assert.match(section, /gitWizard: "1", deviceId: targetDevice\.id/);
  assert.match(settings, /gitWizardParam/);
  assert.match(settings, /setSelectedOnboardingTargetIds\(\[gitWizardDeviceParam\]\)/);
  assert.match(settings, /gitOnboardingSectionY\.current/);
});
