import assert from "node:assert/strict";
import test from "node:test";

import { mergeFetchedTasks } from "./taskListMerge.ts";

test("keeps tasks from other devices when polling one runner", () => {
  const merged = mergeFetchedTasks(
    [
      { id: "task-a", deviceId: "runner-a", status: "running", updatedAt: 100, output: [] },
      { id: "task-b", deviceId: "runner-b", status: "running", updatedAt: 200, output: [] },
    ] as any,
    [
      { id: "task-a", deviceId: "runner-a", status: "running", updatedAt: 150, output: [] },
    ] as any,
    "runner-a",
    1_000,
  );

  assert.deepEqual(merged.map((task) => task.id), ["task-b", "task-a"]);
});

test("keeps a just-created task until the runner list catches up", () => {
  const merged = mergeFetchedTasks(
    [
      { id: "task-new", deviceId: "runner-a", status: "running", updatedAt: 980, output: [] },
    ] as any,
    [] as any,
    "runner-a",
    1_000,
  );

  assert.deepEqual(merged.map((task) => task.id), ["task-new"]);
});

test("drops stale missing tasks from the polled device", () => {
  const merged = mergeFetchedTasks(
    [
      { id: "task-stale", deviceId: "runner-a", status: "completed", updatedAt: 1, output: [] },
      { id: "task-local", runnerId: "yaver-agent", status: "running", updatedAt: 1, output: [] },
    ] as any,
    [] as any,
    "runner-a",
    100_000,
  );

  assert.deepEqual(merged.map((task) => task.id), ["task-local"]);
});
