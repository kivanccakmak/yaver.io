import type { Task, TaskStatus } from "./quic";

const RECENT_UNSEEN_TASK_GRACE_MS = 45_000;

function isYaverAgentTask(task: Task): boolean {
  return task.runnerId === "yaver-agent" || task.id.startsWith("yaver-agent-");
}

function isPhoneLocalTaskRow(task: Task): boolean {
  return task.runnerId === "yaver-phone" || task.source === "phone-local";
}

function isPendingCloudTask(task: Task): boolean {
  return task.id.startsWith("pending-cloud:");
}

function isLocalOnlyTask(task: Task): boolean {
  return isPhoneLocalTaskRow(task) || isYaverAgentTask(task) || isPendingCloudTask(task);
}

function taskBelongsToPolledDevice(task: Task, polledDeviceId: string): boolean {
  if (!polledDeviceId) return true;
  if (!task.deviceId) return true;
  return task.deviceId === polledDeviceId;
}

function shouldGraceKeepRecentTask(task: Task, now: number): boolean {
  const updatedAt = typeof task.updatedAt === "number" ? task.updatedAt : 0;
  if (!updatedAt || now - updatedAt > RECENT_UNSEEN_TASK_GRACE_MS) return false;
  const status = task.status as TaskStatus;
  return status === "queued" || status === "running" || status === "ready" || status === "review" || status === "completed";
}

export function mergeFetchedTasks(
  previous: Task[],
  fetched: Task[],
  polledDeviceId: string,
  now = Date.now(),
): Task[] {
  const key = (task: Task) => `${task.deviceId || polledDeviceId || "local"}:${task.id}`;
  const fetchedIds = new Set(fetched.map(key));
  const preserved = previous.filter((task) => {
    if (fetchedIds.has(key(task))) return false;
    if (isLocalOnlyTask(task)) return true;
    if (!taskBelongsToPolledDevice(task, polledDeviceId)) return true;
    return shouldGraceKeepRecentTask(task, now);
  });
  return [...preserved, ...fetched].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
