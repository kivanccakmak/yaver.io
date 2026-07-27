/**
 * opencodeModel.test.ts — `npx tsx lib/opencodeModel.test.ts`.
 *
 * Pins pre-send OpenCode model validation (audit §6 item 5): a selection the
 * box's probed config cannot serve must be stopped BEFORE dispatch with a
 * named error, while missing telemetry must never produce a false veto.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateOpenCodeModel } from "./opencodeModel";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const snapshot = {
  model: "zai-coding-plan/glm-4.7",
  models: [{ id: "zai-coding-plan/glm-4.7" }, { id: "zai-coding-plan/glm-5.2" }],
  providers: [{ id: "zai-coding-plan", models: ["glm-4.7", "glm-5.2"] }],
  updatedAt: Date.now() - 5 * 60_000,
};

test("listed model passes; bare provider-model combo passes", () => {
  assert.deepEqual(validateOpenCodeModel(snapshot, "zai-coding-plan/glm-4.7"), { ok: true });
  assert.deepEqual(validateOpenCodeModel(snapshot, "glm-5.2"), { ok: true });
});

test("unknown provider is vetoed with the provider roster named", () => {
  const v = validateOpenCodeModel(snapshot, "anthropic/claude-sonnet-4-5");
  assert.equal(v.ok, false);
  assert.match((v as any).error, /provider "anthropic"/);
  assert.match((v as any).error, /zai-coding-plan/);
  assert.match((v as any).error, /opencode\.json/);
});

test("unknown model on a known provider is vetoed with known models listed", () => {
  const v = validateOpenCodeModel(snapshot, "zai-coding-plan/glm-9000");
  assert.equal(v.ok, false);
  assert.match((v as any).error, /glm-9000/);
  assert.match((v as any).error, /Known models:/);
  assert.match((v as any).error, /probed 5m ago/);
});

test("ignorance never vetoes: no snapshot / empty roster / no selection", () => {
  assert.deepEqual(validateOpenCodeModel(null, "any/model"), { ok: true });
  assert.deepEqual(validateOpenCodeModel({}, "any/model"), { ok: true });
  assert.deepEqual(validateOpenCodeModel(snapshot, ""), { ok: true });
  assert.deepEqual(validateOpenCodeModel(snapshot, null), { ok: true });
});

test("dispatch surfaces consume the validator (no dead seam)", () => {
  for (const rel of ["components/dashboard/RuntimeLabView.tsx", "components/dashboard/VibeCodingView.tsx"]) {
    const src = readFileSync(join(webRoot, rel), "utf8");
    assert.match(src, /validateOpenCodeModel/, `${rel} must validate before dispatch`);
  }
});
