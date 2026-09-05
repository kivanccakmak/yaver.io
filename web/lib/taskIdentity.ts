export type ScopedTaskIdentity = {
  id: string;
  deviceId?: string;
};

/** Task ids are only unique inside an agent. The device id is therefore part
 * of the UI identity everywhere multiple machines can contribute history. */
export function scopedTaskKey(task: ScopedTaskIdentity): string {
  return `${String(task.deviceId || "").trim()}:${task.id}`;
}

/** Keep the first row for each machine/task pair. Callers should order rows by
 * freshness first, which makes this deterministic while retaining equal task
 * ids that genuinely belong to different machines. */
export function dedupeScopedTasks<T extends ScopedTaskIdentity>(tasks: readonly T[]): T[] {
  const seen = new Set<string>();
  return tasks.filter((task) => {
    const key = scopedTaskKey(task);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
