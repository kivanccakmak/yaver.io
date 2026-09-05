import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  YAVER_MODEL_DEFAULTS,
  applyRunnerModelDefaults,
  parseRunnerModelDefaults,
} from "./modelDefaults.ts";

test("Convex defaults match the Yaver runner contract", () => {
  assert.deepEqual(YAVER_MODEL_DEFAULTS, {
    claude: { model: "claude-opus-4-8" },
    codex: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    opencode: { model: "deepseek/deepseek-v4-flash" },
  });
});

test("stored Convex defaults override bootstrap values and invalid fields fail closed", () => {
  assert.deepEqual(parseRunnerModelDefaults(JSON.stringify({
    codex: { model: "future-codex", reasoningEffort: "xhigh" },
    unknown: { model: "bad" },
  })), {
    claude: { model: "claude-opus-4-8" },
    codex: { model: "future-codex", reasoningEffort: "xhigh" },
    opencode: { model: "deepseek/deepseek-v4-flash" },
  });
});

test("stale aiModels rows cannot remain the advertised default", () => {
  const rows = applyRunnerModelDefaults([
    { runnerId: "codex", modelId: "gpt-5.4", isDefault: true, sortOrder: 1 },
  ], YAVER_MODEL_DEFAULTS);
  assert.equal(rows.find((row) => row.modelId === "gpt-5.4")?.isDefault, false);
  assert.equal(rows.find((row) => row.modelId === "gpt-5.6-sol")?.isDefault, true);
});

test("global-default mutation is full-session and owner gated", () => {
  const source = fs.readFileSync(new URL("./http.ts", import.meta.url), "utf8");
  const start = source.indexOf('path: "/config/model-defaults"');
  const end = source.indexOf("// ── Public install catalogue", start);
  assert.ok(start >= 0, "route must exist");
  const route = source.slice(start, end);
  assert.match(route, /authenticateRequest\(ctx, request\)/);
  assert.match(route, /requireFullScope\(session\)/);
  assert.match(route, /isOwner\(session\.email, String\(session\.userDocId\)\)/);
  assert.match(route, /internal\.platformConfig\.get/);
  assert.match(route, /internal\.platformConfig\.set/);
});
