import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const tasksSource = readFileSync(new URL("../../app/(tabs)/tasks.tsx", import.meta.url), "utf8");
const webClientSource = readFileSync(new URL("../../../web/lib/agent-client.ts", import.meta.url), "utf8");

test("task submit has a visible web-safe failure route and preserves the prompt", () => {
  assert.match(tasksSource, /testID="task-submit-error"/);
  assert.match(tasksSource, /Your prompt is preserved\. Tap Send to retry/);
  assert.match(tasksSource, /setTaskSubmitError\(`\$\{targetName\} did not accept this task:/);
  assert.match(tasksSource, /if \(submitInFlightRef\.current\) return;[\s\S]*?listTasks\(\)/);
});

test("both browser task clients bound acknowledgement time", () => {
  const sendTaskStart = webClientSource.indexOf("async sendTask(");
  const createTaskStart = webClientSource.indexOf("async createTask(", sendTaskStart);
  assert.ok(sendTaskStart >= 0 && createTaskStart > sendTaskStart);
  const sendTask = webClientSource.slice(sendTaskStart, createTaskStart);
  assert.match(sendTask, /this\.fetchWithTimeout\([\s\S]*?\/tasks[\s\S]*?30_000/);
  assert.match(sendTask, /Your prompt was not cleared/);
});
