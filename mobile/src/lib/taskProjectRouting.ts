/**
 * Project paths are machine-local. A portable project name may cross the
 * runner boundary, but an absolute path must stay on the machine that reported
 * it. This keeps a task from failing in another box's nonexistent checkout.
 */
export function workDirForTaskExecution(args: {
  workDir?: string | null;
  projectDeviceId?: string | null;
  executionDeviceId?: string | null;
}): string | undefined {
  const workDir = String(args.workDir || "").trim();
  if (!workDir) return undefined;

  const projectDeviceId = String(args.projectDeviceId || "").trim();
  const executionDeviceId = String(args.executionDeviceId || "").trim();
  if (projectDeviceId && executionDeviceId && projectDeviceId !== executionDeviceId) {
    return undefined;
  }
  return workDir;
}

/** A compact task-detail explanation that avoids exposing a stale foreign path. */
export function taskProjectExecutionSummary(args: {
  projectName?: string | null;
  workDir?: string | null;
  deviceName?: string | null;
}): string {
  const workDir = String(args.workDir || "").trim();
  const projectName = String(args.projectName || "").trim()
    || workDir.split(/[\\/]/).filter(Boolean).pop()
    || "No project";
  const deviceName = String(args.deviceName || "").trim() || "this machine";
  return projectName === "No project"
    ? `No project · runner defaults on ${deviceName}`
    : `Project: ${projectName} · resolved on ${deviceName}`;
}
