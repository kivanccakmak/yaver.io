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

/**
 * Convex-backed last-project memory (2026-08-09). The canonical cross-surface
 * store is `defaultRuntimeProjectByDevice` (backend/convex/userSettings.ts
 * mergeRuntimeProjectPreference, replace-by-deviceId) — the SAME row the web
 * dashboard's VibeCodingView writes via POST /settings, so a project remembered
 * on the phone is remembered on the web (and vice versa). Privacy-limited by
 * design: no absolute paths, only {projectName, gitRemote, branch}.
 *
 * Local AsyncStorage stays as the offline fallback: boot reads Convex first,
 * falls back to the local row; writes go to BOTH. Never blocks task creation —
 * a failed settings write is swallowed exactly like a failed local write.
 */

export async function saveLastTaskProjectToConvex(
  token: string | null | undefined,
  project: Omit<TaskLastProject, "updatedAt">,
): Promise<void> {
  if (!token || !project.deviceId || !project.name) return;
  try {
    // Lazy import: auth.ts drags in react-native/expo-secure-store, which
    // esbuild cannot transform — the node test for this file imports it
    // directly, so the RN module chain must stay out of module scope.
    const { saveUserSettings } = await import("./auth");
    await saveUserSettings(token, {
      defaultRuntimeProjectForDevice: {
        deviceId: project.deviceId,
        projectName: project.name,
        ...(project.gitRemote ? { gitRemote: project.gitRemote } : {}),
        ...(project.branch ? { branch: project.branch } : {}),
      },
    });
  } catch {
    // Never block task creation on a failed settings write (same rule as the
    // local write above).
  }
}

/**
 * Read the Convex-stored last project for a device. Returns null when there is
 * no row, no token, or the settings fetch fails (caller falls back to local).
 * The Convex row carries no absolute path — the caller matches by name/remote
 * against its live project list.
 */
export async function loadLastTaskProjectFromConvex(
  token: string | null | undefined,
  deviceId: string,
): Promise<Omit<TaskLastProject, "updatedAt"> | null> {
  if (!token || !deviceId) return null;
  try {
    const { getUserSettings } = await import("./auth");
    const settings = await getUserSettings(token);
    const rows = settings?.defaultRuntimeProjectByDevice;
    if (!Array.isArray(rows)) return null;
    const row = rows.find((r) => r?.deviceId === deviceId && r?.projectName);
    if (!row?.projectName) return null;
    return {
      deviceId,
      name: String(row.projectName),
      ...(row.gitRemote ? { gitRemote: String(row.gitRemote) } : {}),
      ...(row.branch ? { branch: String(row.branch) } : {}),
    };
  } catch {
    return null;
  }
}

// ── Convex-backed MCP selection memory (2026-08-10) ──────────────────────
// Same `mcpServersByDevice` row the web dashboard's RuntimeLabView and chat
// composer write via POST /settings, so an MCP selection made on the phone is
// remembered on the web/TV and vice versa. Shape mirrors
// web/lib/runtimeProjectSettings.ts's load/saveMCPServersToConvex — one row,
// every surface. Local AsyncStorage stays as the offline fallback: boot reads
// Convex first, falls back to the local row; writes go to BOTH. Never blocks
// task creation.

export type MCPServersPreference = {
  deviceId: string;
  mcpServers?: string[];
  includeYaverMcp?: boolean;
  updatedAt?: number;
};

/** Read mcpServersByDevice for one device. Null when absent / unreadable
 *  (caller falls back to local state). */
export async function loadMCPServersFromConvex(
  token: string | null | undefined,
  deviceId: string | null | undefined,
): Promise<MCPServersPreference | null> {
  if (!token || !deviceId) return null;
  try {
    const { getUserSettings } = await import("./auth");
    const settings = await getUserSettings(token);
    const rows = settings?.mcpServersByDevice;
    if (!Array.isArray(rows)) return null;
    const row = rows.find((r) => r?.deviceId === deviceId);
    if (!row) return null;
    return {
      deviceId,
      ...(Array.isArray(row.mcpServers) ? { mcpServers: row.mcpServers.map(String) } : {}),
      ...(typeof row.includeYaverMcp === "boolean" ? { includeYaverMcp: row.includeYaverMcp } : {}),
      ...(typeof row.updatedAt === "number" ? { updatedAt: row.updatedAt } : {}),
    };
  } catch {
    return null;
  }
}

/** Write mcpServersForDevice (replace-by-deviceId on the server). MCP names
 *  only — URLs/keys stay on the agent. Never blocks task creation. */
export async function saveMCPServersToConvex(
  token: string | null | undefined,
  pref: MCPServersPreference,
): Promise<void> {
  if (!token || !pref.deviceId) return;
  try {
    const { saveUserSettings } = await import("./auth");
    await saveUserSettings(token, {
      mcpServersForDevice: {
        deviceId: pref.deviceId,
        ...(pref.mcpServers?.length ? { mcpServers: pref.mcpServers } : {}),
        ...(typeof pref.includeYaverMcp === "boolean" ? { includeYaverMcp: pref.includeYaverMcp } : {}),
      },
    });
  } catch {
    // Never block task creation on a failed settings write.
  }
}
