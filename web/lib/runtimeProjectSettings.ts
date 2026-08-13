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

// ── MCP selection preference, Convex-backed (2026-08-09) ───────────────
// Per-device `mcpServersByDevice` (replace-by-deviceId): which external MCP
// servers a task attaches, plus whether Yaver's own `yaver mcp` doorway is
// included (default true). Synced so the phone and the web dashboard agree.

export type MCPServersPreference = {
  deviceId: string;
  mcpServers?: string[];
  includeYaverMcp?: boolean;
  updatedAt?: number;
};

/** Read mcpServersByDevice for one device. Null when absent / unreadable
 *  (caller falls back to local state). */
export async function loadMCPServersFromConvex(
  convexUrl: string,
  token: string | null | undefined,
  deviceId: string | null | undefined,
): Promise<MCPServersPreference | null> {
  if (!token || !deviceId) return null;
  try {
    const res = await fetch(`${convexUrl}/settings`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const rows = data?.settings?.mcpServersByDevice;
    if (!Array.isArray(rows)) return null;
    const row = rows.find((r: any) => r?.deviceId === deviceId);
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
  convexUrl: string,
  token: string | null | undefined,
  pref: MCPServersPreference,
): Promise<void> {
  if (!token || !pref.deviceId) return;
  try {
    await fetch(`${convexUrl}/settings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        mcpServersForDevice: {
          deviceId: pref.deviceId,
          ...(pref.mcpServers?.length ? { mcpServers: pref.mcpServers } : {}),
          ...(typeof pref.includeYaverMcp === "boolean" ? { includeYaverMcp: pref.includeYaverMcp } : {}),
        },
      }),
    });
  } catch {
    // Never block task creation on a failed settings write.
  }
}

// ── Cross-machine surface catalogs (2026-08-13) ─────────────────────────
// userSettings.mcpCatalogByDevice / runtimeProjectCatalogByDevice, seeded by
// each agent's Convex heartbeat (convex_state_sync.go buildMCPCatalog +
// buildRuntimeProjectCatalog). These answer "which MCP server / which git
// project lives on which machine" WITHOUT fanning out to every box — the web
// chat composer and mobile composer render another machine's MCPs as
// selectable chips and browse other machines' projects.
// Privacy contract: names/URLs/remotes/branches/frameworks only — NEVER
// absolute paths or MCP auth tokens.

export type MCPCatalogServer = {
  name: string;
  url: string;
  enabled: boolean;
  toolCount?: number;
};

/** Map mcpCatalogByDevice rows → deviceId → enabled servers. Rows the agent
 *  never synced (still-empty catalog) degrade to absent keys. */
export function mcpCatalogMap(
  rows?: Array<{ deviceId: string; servers?: Array<{ name?: string; url?: string; enabled?: boolean; toolCount?: number }> }>,
): Record<string, MCPCatalogServer[]> {
  const out: Record<string, MCPCatalogServer[]> = {};
  for (const row of rows || []) {
    if (!row?.deviceId) continue;
    const servers: MCPCatalogServer[] = [];
    for (const s of Array.isArray(row.servers) ? row.servers : []) {
      if (!s || !s.name || s.enabled === false) continue;
      servers.push({
        name: String(s.name).trim(),
        url: String(s.url || "").trim(),
        enabled: true,
        ...(typeof s.toolCount === "number" && s.toolCount >= 0 ? { toolCount: s.toolCount } : {}),
      });
    }
    if (servers.length > 0) out[row.deviceId] = servers;
  }
  return out;
}

export type SurfaceCatalogs = {
  mcpByDevice: Record<string, MCPCatalogServer[]>;
  projectsByDevice: Record<string, RuntimeProjectSeed[]>;
};

/** One /settings fetch returning BOTH cross-machine catalogs. Reads the
 *  account's settings row (auth'd via bearer). Degrades to empty maps on any
 *  failure — catalogs are advisory, never block. */
export async function loadSurfaceCatalogsFromConvex(
  convexUrl: string,
  token: string | null | undefined,
): Promise<SurfaceCatalogs> {
  const empty: SurfaceCatalogs = { mcpByDevice: {}, projectsByDevice: {} };
  if (!token) return empty;
  try {
    const res = await fetch(`${convexUrl}/settings`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return empty;
    const data = await res.json().catch(() => null);
    const settings = data?.settings;
    if (!settings) return empty;
    const projectsByDevice: Record<string, RuntimeProjectSeed[]> = {};
    for (const row of Object.values(runtimeProjectCatalogMap(settings.runtimeProjectCatalogByDevice))) {
      if (row?.deviceId && Array.isArray(row.projects) && row.projects.length > 0) {
        projectsByDevice[row.deviceId] = row.projects;
      }
    }
    return {
      mcpByDevice: mcpCatalogMap(settings.mcpCatalogByDevice),
      projectsByDevice,
    };
  } catch {
    return empty;
  }
}

