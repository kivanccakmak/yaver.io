export interface TaskRuntimeIdentity {
  runnerId?: string;
  source?: string;
}

/** One truth for every Tasks lifecycle action that must stay on the phone. */
export function isPhoneLocalTask(task: TaskRuntimeIdentity | null | undefined): boolean {
  return task?.runnerId === "yaver-phone" || task?.source === "phone-local";
}

export function phoneLocalTurnStatus(changedFileCount: number): "review" | "completed" {
  return changedFileCount > 0 ? "review" : "completed";
}
