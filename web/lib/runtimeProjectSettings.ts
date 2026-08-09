export type RuntimeProjectSeed = {
  projectName?: string | null;
  repoName?: string | null;
  gitProvider?: string | null;
  gitRemote?: string | null;
  branch?: string | null;
  framework?: string | null;
  updatedAt?: number | null;
};

export type RuntimeProjectPreference = RuntimeProjectSeed & {
  deviceId: string;
  projectName: string;
  updatedAt?: number;
};

export type RuntimeProjectCatalogRow = {
  deviceId: string;
  projects: RuntimeProjectSeed[];
  updatedAt?: number;
};

export function runtimeProjectDisplayName(project: RuntimeProjectSeed | undefined): string {
  const name = String(project?.projectName || project?.repoName || "").trim();
  return name || "Unnamed project";
}

export function runtimeProjectMeta(project: RuntimeProjectSeed | undefined): string {
  return [
    String(project?.gitProvider || "").trim(),
    String(project?.repoName || "").trim(),
    String(project?.branch || "").trim(),
    String(project?.framework || "").trim(),
  ].filter(Boolean).join(" / ");
}

export function runtimeProjectPreferenceFor(deviceId: string, project: RuntimeProjectSeed): RuntimeProjectPreference {
  return {
    deviceId,
    projectName: runtimeProjectDisplayName(project),
    ...(project.repoName ? { repoName: String(project.repoName).trim() } : {}),
    ...(project.gitProvider ? { gitProvider: String(project.gitProvider).trim() } : {}),
    ...(project.gitRemote ? { gitRemote: String(project.gitRemote).trim() } : {}),
    ...(project.branch ? { branch: String(project.branch).trim() } : {}),
    ...(project.framework ? { framework: String(project.framework).trim() } : {}),
    updatedAt: Date.now(),
  };
}

function norm(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function runtimeProjectIdentityScore(project: RuntimeProjectSeed, pref?: RuntimeProjectSeed | null): number {
  if (!pref) return 0;
  let score = 0;
  if (project.gitRemote && pref.gitRemote && norm(project.gitRemote) === norm(pref.gitRemote)) score += 8;
  if (project.repoName && pref.repoName && norm(project.repoName) === norm(pref.repoName)) score += 4;
  if (project.projectName && pref.projectName && norm(project.projectName) === norm(pref.projectName)) score += 2;
  if (project.branch && pref.branch && norm(project.branch) === norm(pref.branch)) score += 1;
  if (project.framework && pref.framework && norm(project.framework) === norm(pref.framework)) score += 1;
  return score;
}

export function resolveRuntimeProjectPreference(
  projects: RuntimeProjectSeed[],
  pref?: RuntimeProjectSeed | null,
): RuntimeProjectSeed | null {
  let best: RuntimeProjectSeed | null = null;
  let bestScore = 0;
  for (const project of projects) {
    const score = runtimeProjectIdentityScore(project, pref);
    if (score > bestScore) {
      best = project;
      bestScore = score;
    }
  }
  return best;
}

export function runtimeProjectCatalogMap(rows?: RuntimeProjectCatalogRow[]): Record<string, RuntimeProjectCatalogRow> {
  const out: Record<string, RuntimeProjectCatalogRow> = {};
  for (const row of rows || []) {
    if (!row?.deviceId) continue;
    out[row.deviceId] = {
      deviceId: row.deviceId,
      projects: Array.isArray(row.projects) ? row.projects : [],
      updatedAt: row.updatedAt,
    };
  }
  return out;
}

export function runtimeProjectDefaultMap(rows?: RuntimeProjectPreference[]): Record<string, RuntimeProjectPreference> {
  const out: Record<string, RuntimeProjectPreference> = {};
  for (const row of rows || []) {
    if (!row?.deviceId || !row.projectName) continue;
    out[row.deviceId] = row;
  }
  return out;
}

// ── Convex-backed last-project memory (2026-08-09) ─────────────────────
// The canonical cross-surface store is `defaultRuntimeProjectByDevice`
// (backend/convex/userSettings.ts mergeRuntimeProjectPreference,
// replace-by-deviceId) — the SAME row mobile writes via
// taskComposerPrefs.saveLastTaskProjectToConvex, so a project remembered
// on the web shows up on the phone and vice versa. localStorage stays as
// the offline fallback: boot reads Convex first, falls back to the local
// row; writes go to BOTH. Never blocks task creation — a failed settings
// write is swallowed exactly like a failed localStorage write.

/** Read defaultRuntimeProjectByDevice for one device. Null when absent /
 *  unreadable (caller falls back to localStorage). */
export async function loadLastProjectFromConvex(
  convexUrl: string,
  token: string | null | undefined,
  deviceId: string | null | undefined,
): Promise<RuntimeProjectPreference | null> {
  if (!token || !deviceId) return null;
  try {
    const res = await fetch(`${convexUrl}/settings`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const rows = data?.settings?.defaultRuntimeProjectByDevice;
    if (!Array.isArray(rows)) return null;
    const row = rows.find((r: any) => r?.deviceId === deviceId && r?.projectName);
    if (!row?.projectName) return null;
    return runtimeProjectPreferenceFor(deviceId, row);
  } catch {
    return null;
  }
}

/** Write defaultRuntimeProjectForDevice (replace-by-deviceId on the
 *  server). No absolute paths — privacy-limited to what the schema allows:
 *  projectName / gitRemote / branch. */
export async function saveLastProjectToConvex(
  convexUrl: string,
  token: string | null | undefined,
  project: RuntimeProjectPreference,
): Promise<void> {
  if (!token || !project.deviceId || !project.projectName) return;
  try {
    await fetch(`${convexUrl}/settings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        defaultRuntimeProjectForDevice: {
          deviceId: project.deviceId,
          projectName: project.projectName,
          ...(project.gitRemote ? { gitRemote: project.gitRemote } : {}),
          ...(project.branch ? { branch: project.branch } : {}),
        },
      }),
    });
  } catch {
    // Never block task creation on a failed settings write.
  }
}

