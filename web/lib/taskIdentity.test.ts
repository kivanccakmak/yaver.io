import assert from "node:assert/strict";
import test from "node:test";

import { dedupeScopedTasks, scopedTaskKey } from "./taskIdentity";

test("scoped task identity includes the machine", () => {
  assert.notEqual(
    scopedTaskKey({ deviceId: "machine-a", id: "task-1" }),
    scopedTaskKey({ deviceId: "machine-b", id: "task-1" }),
  );
});

test("dedupe keeps the first fresh row for an exact machine/task duplicate", () => {
  const rows = dedupeScopedTasks([
    { deviceId: "machine-a", id: "task-1", version: "fresh" },
    { deviceId: "machine-a", id: "task-1", version: "stale" },
    { deviceId: "machine-b", id: "task-1", version: "other machine" },
  ]);
  assert.deepEqual(rows.map((row) => row.version), ["fresh", "other machine"]);
});
