import assert from "node:assert/strict";
import test from "node:test";

import { taskProjectExecutionSummary, workDirForTaskExecution } from "./taskProjectRouting.ts";

test("workDirForTaskExecution keeps a path on its reporting machine", () => {
  assert.equal(
    workDirForTaskExecution({
      workDir: "/Users/example/Workspace/yaver.io",
      projectDeviceId: "mac",
      executionDeviceId: "mac",
    }),
    "/Users/example/Workspace/yaver.io",
  );
});

test("workDirForTaskExecution sends only portable project identity across machines", () => {
  assert.equal(
    workDirForTaskExecution({
      workDir: "/Users/example/Workspace/yaver.io",
      projectDeviceId: "mac",
      executionDeviceId: "linux",
    }),
    undefined,
  );
});

test("taskProjectExecutionSummary names the project and runner machine", () => {
  assert.equal(
    taskProjectExecutionSummary({ projectName: "yaver.io", deviceName: "Mac mini" }),
    "Project: yaver.io · resolved on Mac mini",
  );
  assert.equal(
    taskProjectExecutionSummary({ workDir: "/workspaces/talos", deviceName: "Linux builder" }),
    "Project: talos · resolved on Linux builder",
  );
});
