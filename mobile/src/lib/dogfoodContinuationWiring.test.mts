import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "dogfoodThread.ts"), "utf8");

test("Dogfood follows up in the existing task instead of spawning every message", () => {
  assert.match(source, /prior\?\.taskId[\s\S]*client\.continueTask\(prior\.taskId, prompt, images\)/);
  assert.match(source, /taskId = prior\.taskId/);
  assert.match(source, /continued = true/);
});

test("Dogfood only resumes a compatible device runner and mode", () => {
  assert.match(source, /it\.deviceId === deviceId/);
  assert.match(source, /it\.mode === mode/);
  assert.match(source, /it\.runner === opts\.runner/);
});
