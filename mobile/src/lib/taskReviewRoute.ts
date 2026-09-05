/**
 * Pure notification-to-route contract. Kept outside the native notification
 * module so it can be proved in Node as well as used during a cold Expo launch.
 */
export type TaskReviewNotificationData = {
  kind?: unknown;
  taskId?: unknown;
  deviceId?: unknown;
  openedAt?: unknown;
};

export function shouldNotifyTaskReview(
  previousStatus: string | null | undefined,
  nextStatus: string | null | undefined,
): boolean {
  return nextStatus === "review" && (previousStatus === "running" || previousStatus === "queued");
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function taskReviewNotificationRoute(data: TaskReviewNotificationData): {
  pathname: "/(tabs)/tasks";
  params: Record<string, string>;
} | null {
  if (data?.kind !== "task-review") return null;
  const taskId = asNonEmptyString(data.taskId);
  const deviceId = asNonEmptyString(data.deviceId);
  const openedAt = asNonEmptyString(data.openedAt) || String(Date.now());
  return {
    pathname: "/(tabs)/tasks",
    params: {
      ...(taskId ? { taskId } : {}),
      ...(deviceId ? { taskDeviceId: deviceId } : {}),
      taskNotificationNonce: openedAt,
    },
  };
}
