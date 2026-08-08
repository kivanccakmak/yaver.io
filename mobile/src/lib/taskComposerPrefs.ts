import AsyncStorage from "@react-native-async-storage/async-storage";

export const TASK_VIDEO_SUMMARY_KEY = "@yaver/tasks_video_summary_enabled";
export const TASK_KEEP_LAST_PROJECT_KEY = "@yaver/tasks_keep_last_project";
export const TASK_LAST_PROJECT_PREFIX = "@yaver/last_project/v1/";

export type TaskLastProject = {
  deviceId: string;
  name: string;
  path?: string;
  gitRemote?: string;
  branch?: string;
  updatedAt: number;
};

export async function loadTaskVideoSummaryEnabled(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(TASK_VIDEO_SUMMARY_KEY);
    return raw === "1";
  } catch {
    return false;
  }
}

export async function saveTaskVideoSummaryEnabled(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(TASK_VIDEO_SUMMARY_KEY, enabled ? "1" : "0");
  } catch {
    // Ignore local preference write failures; task creation still works.
  }
}

export async function loadKeepLastProjectEnabled(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(TASK_KEEP_LAST_PROJECT_KEY);
    return raw !== "0";
  } catch {
    return true;
  }
}

export async function saveKeepLastProjectEnabled(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(TASK_KEEP_LAST_PROJECT_KEY, enabled ? "1" : "0");
  } catch {
    // Local preference only.
  }
}

function lastProjectKey(deviceId: string): string {
  return `${TASK_LAST_PROJECT_PREFIX}${String(deviceId || "default").trim() || "default"}`;
}

export async function loadLastTaskProject(deviceId: string): Promise<TaskLastProject | null> {
  try {
    const raw = await AsyncStorage.getItem(lastProjectKey(deviceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TaskLastProject>;
    if (!parsed || !parsed.name) return null;
    return {
      deviceId,
      name: String(parsed.name),
      path: parsed.path ? String(parsed.path) : undefined,
      gitRemote: parsed.gitRemote ? String(parsed.gitRemote) : undefined,
      branch: parsed.branch ? String(parsed.branch) : undefined,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export async function saveLastTaskProject(project: Omit<TaskLastProject, "updatedAt">): Promise<void> {
  if (!project.deviceId || !project.name) return;
  try {
    await AsyncStorage.setItem(lastProjectKey(project.deviceId), JSON.stringify({ ...project, updatedAt: Date.now() }));
  } catch {
    // Task creation must not depend on local preference writes.
  }
}
