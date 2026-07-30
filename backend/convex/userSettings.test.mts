import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dirname, "userSettings.ts"), "utf8");

test("settings normalizer upgrades obsolete Codex model rows", () => {
  assert.match(source, /OBSOLETE_CODEX_MODEL_IDS[\s\S]*gpt-5\.3-codex/);
  assert.match(source, /CURRENT_CODEX_MODEL_ID = "gpt-5\.4"/);
  assert.match(source, /String\(row\.runnerId \|\| ""\)\.trim\(\)\.toLowerCase\(\) === "codex"/);
  assert.match(source, /return \{ \.\.\.row, model: CURRENT_CODEX_MODEL_ID \}/);
});

test("settings reads and writes pass through primary runner normalization", () => {
  assert.match(source, /return normalizeSettingsForClient\(settings\)/);
  assert.match(source, /const normalizedPrimaryRunnerRows = normalizePrimaryRunnerRowsForClient/);
  assert.match(source, /patch\.primaryRunnerByDevice = normalizedPrimaryRunnerRows/);
});
