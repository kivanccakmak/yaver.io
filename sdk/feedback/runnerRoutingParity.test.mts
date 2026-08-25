import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const rnModal = readFileSync(join(here, "react-native/src/FeedbackModal.tsx"), "utf8");
const rnClient = readFileSync(join(here, "react-native/src/P2PClient.ts"), "utf8");
const webOverlay = readFileSync(join(here, "web/src/YaverFeedback.ts"), "utf8");
const webClient = readFileSync(join(here, "web/src/P2PClient.ts"), "utf8");

test("feedback SDK Vibing surfaces show and pin runner plus model", () => {
  assert.ok(rnModal.includes("Vibing uses"));
  assert.ok(rnModal.includes("setPreferredRunner(row.id)"));
  assert.ok(rnModal.includes("setPreferredModel(model.id)"));
  assert.ok(rnModal.includes("runner: preferredRunner ?? undefined"));
  assert.ok(rnModal.includes("model: preferredModel ?? undefined"));

  assert.ok(webOverlay.includes('aria-label="Runner and model for Vibing"'));
  assert.ok(webOverlay.includes("runner: selectedRunnerId || undefined"));
  assert.ok(webOverlay.includes("model: selectedModelId || undefined"));
  assert.ok(webClient.includes("runner: opts?.runner"));
  assert.ok(webClient.includes("model: opts?.model"));
});

test("feedback SDK runner failures keep an executable route", () => {
  assert.ok(rnClient.includes("getAvailableRunners HTTP"));
  assert.ok(rnModal.includes("setRunnerAuthModal"));
  assert.ok(webOverlay.includes("YaverFeedback.installRunner(runner)"));
  assert.ok(webOverlay.includes("YaverFeedback.signInRunner(runner)"));
  assert.ok(webOverlay.includes("YaverFeedback.setupRunnerAuth(runner)"));
  assert.ok(webOverlay.includes("Could not load agent selection."));
});
