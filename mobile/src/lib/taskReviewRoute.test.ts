import { taskReviewNotificationRoute } from "./taskReviewRoute";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const exact = taskReviewNotificationRoute({
  kind: "task-review",
  taskId: "task_123",
  deviceId: "runner_mac",
  openedAt: 42,
});
assert(exact?.pathname === "/(tabs)/tasks", "review must navigate to Tasks");
assert(exact.params.taskId === "task_123", "review route must keep its exact task id");
assert(exact.params.taskDeviceId === "runner_mac", "review route must keep the owning device id");
assert(exact.params.taskNotificationNonce === "42", "numeric notification nonce must survive serialization");
assert(taskReviewNotificationRoute({ kind: "device_auth_request" }) === null, "unrelated push must not open Tasks");

console.log("taskReviewRoute: 5 passed, 0 failed");
