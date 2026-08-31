export interface TaskRuntimeIdentity {
  runnerId?: string;
  source?: string;
}

/** One truth for every Tasks lifecycle action that must stay on the phone. */
export function isPhoneLocalTask(task: TaskRuntimeIdentity | null | undefined): boolean {
  return task?.runnerId === "yaver-phone" || task?.source === "phone-local";
}

/** A local coding turn that changed files is ready for the user's next message,
 * not implicitly "ready to review". Review is an explicit completion claim. */
export function phoneLocalTurnStatus(changedFileCount: number): "ready" | "completed" {
  return changedFileCount > 0 ? "ready" : "completed";
}
