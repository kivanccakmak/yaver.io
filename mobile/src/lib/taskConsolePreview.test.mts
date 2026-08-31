import test from "node:test";
import assert from "node:assert/strict";

import { buildTaskConsolePreview } from "./taskConsolePreview.ts";

test("buildTaskConsolePreview keeps the latest human-readable lines", () => {
  const preview = buildTaskConsolePreview([
    "$ pnpm test",
    "Compiling mobile task detail",
    "Task detail now shows folded console preview",
  ].join("\n"), true);
  assert.equal(preview, "Compiling mobile task detail Task detail now shows folded console preview");
});

test("buildTaskConsolePreview preserves collapsed-noise context", () => {
  const preview = buildTaskConsolePreview(
    Array.from({ length: 9 }, (_, idx) => `line ${idx + 1}`).join("\n"),
    true,
  );
  assert.match(preview, /line 8 line 9 … \d+ noisy lines collapsed$/);
});
