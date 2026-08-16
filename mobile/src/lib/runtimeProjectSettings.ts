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
  const bits = [
    String(project?.gitProvider || "").trim(),
    String(project?.repoName || "").trim(),
    String(project?.branch || "").trim(),
    String(project?.framework || "").trim(),
  ].filter(Boolean);
  return bits.join(" / ");
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

