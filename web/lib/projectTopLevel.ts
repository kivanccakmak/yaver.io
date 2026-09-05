/**
 * Top-level project contract (2026-08-09) — every project-selection surface
 * (task composers, project pickers, the devices rail, the runtime lab) must
 * offer TOP-LEVEL git projects only: medici.ai, yaver.io, talos, sfmg — never
 * nested clones ("mobile" at <ws>/yaver.io/mobile) and never monorepo-app
 * labels ("yaver.io / mobile", "talos frontend").
 *
 * Sources of the leak this kills:
 *   1. Agent discovery (`/projects`) can report a nested git clone inside
 *      another repo root (a remote box listed <home>/Workspace/yaver.io/mobile
 *      as its own "mobile" project). The agent-side collapseNestedRepos
 *      (desktop/agent/discovery.go) fixes the source; this is the client-side
 *      twin so an older agent cannot leak into a newer web/mobile surface.
 *   2. RuntimeLabView.expandMonorepoProjects fabricates "<root> / <app>"
 *      rows and seeds them into the Convex runtimeProjectCatalog — the only
 *      writer of that catalog, so the sub-project names were persisted.
 *
 * The rule everywhere: the outermost repo root wins.
 */

export type TopLevelProject = {
  name?: string;
  path: string;
  branch?: string | null;
  framework?: string | null;
  gitRemote?: string | null;
  monorepoRoot?: string | null;
  monorepoApp?: string | null;
};

function normalizedProjectPath(value: string): string {
  let normalized = String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
  // Windows drive and UNC paths are case-insensitive even though this code
  // executes in a browser that may itself be running on another OS.
  if (/^[a-z]:\//i.test(normalized) || normalized.startsWith("//")) normalized = normalized.toLowerCase();
  return normalized;
}

export function projectPathsEqual(a: string, b: string): boolean {
  const left = normalizedProjectPath(a);
  return Boolean(left) && left === normalizedProjectPath(b);
}

/** Component-wise "is `path` inside `root`?" — sibling names that merely
 * share a prefix (/ws/yaver.io vs /ws/yaver.io-2) never collide. */
export function pathIsInside(path: string, root: string): boolean {
  const p = normalizedProjectPath(path);
  const r = normalizedProjectPath(root);
  if (!p || !r || r === p) return false;
  return p.startsWith(r + "/");
}

/** Drop any project whose path lives inside another project's path. The
 * shallowest (top-level) roots win; order of the survivors is preserved. */
export function collapseTopLevelProjects<T extends { path: string; name?: string }>(projects: T[]): T[] {
  const kept: T[] = [];
  const sorted = [...projects].sort((a, b) => {
    const da = (a.path || "").split(/[\\/]/).length;
    const db = (b.path || "").split(/[\\/]/).length;
    if (da !== db) return da - db;
    return (a.path || "").localeCompare(b.path || "");
  });
  for (const p of sorted) {
    const nested = kept.some((k) => projectPathsEqual(p.path, k.path) || pathIsInside(p.path, k.path));
    if (!nested) kept.push(p);
  }
  return kept;
}

/** Monorepo-app labels ("<root> / <app>") must never surface as pickable
 * projects. A row carrying monorepoApp is a sub-project of its monorepoRoot. */
export function isMonorepoAppRow(
  project: { name?: string; monorepoApp?: string | null } | null | undefined,
): boolean {
  return !!project?.monorepoApp || String(project?.name || "").includes(" / ");
}

/** The display name for a top-level project: the repo-root basename, never a
 * "<root> / <app>" label. */
export function topLevelDisplayName(
  project: { name?: string; path?: string; monorepoRoot?: string | null } | null | undefined,
): string {
  if (!project) return "Project";
  if (isMonorepoAppRow(project)) {
    return String(project.monorepoRoot || "").split(/[\\/]/).filter(Boolean).pop() || project.name || "Project";
  }
  return project.name || String(project.path || "").split(/[\\/]/).filter(Boolean).pop() || "Project";
}

/** One row of the Convex runtime project catalog
 * (userSettings.runtimeProjectCatalogByDevice). Privacy-limited: names,
 * remotes, branches, frameworks — never absolute paths. */
export type CatalogSeed = {
  projectName?: string | null;
  repoName?: string | null;
  gitProvider?: string | null;
  gitRemote?: string | null;
  branch?: string | null;
  framework?: string | null;
};

/** Enrich agent-discovered projects with the Convex runtime project catalog
 * for the connected machine — the Convex-side memory of the same git
 * projects, seeded by the Go agent (convex_state_sync.go) and the Runtime
 * Lab. A catalog row that matches an agent project by gitRemote or repoName
 * fills in branch/framework the agent may not have reported. Catalog rows
 * with NO agent match are never added: they carry no filesystem path, so
 * they cannot select a workDir. Result is collapsed top-level only. */
export function mergeConvexCatalogIntoProjects<T extends TopLevelProject>(
  projects: T[],
  catalog?: CatalogSeed[] | null,
): T[] {
  const rows = (catalog || []).filter((r) => r && (r.gitRemote || r.repoName));
  if (rows.length === 0) return collapseTopLevelProjects(projects);
  const norm = (v?: string | null) => String(v || "").trim().toLowerCase();
  const enriched = projects.map((p) => {
    const match = rows.find(
      (r) =>
        (p.gitRemote && r.gitRemote && norm(p.gitRemote) === norm(r.gitRemote)) ||
        (r.repoName && norm(r.repoName) === norm(String(p.path).split(/[\\/]/).filter(Boolean).pop())),
    );
    if (!match) return p;
    return {
      ...p,
      branch: p.branch || match.branch || undefined,
      framework: p.framework || match.framework || undefined,
      // The catalog name is the top-level repo identity (e.g. "talos"),
      // never a "<root> / <app>" monorepo-app label — those must never
      // surface as pickable project names.
      name: match.projectName && !match.projectName.includes(" / ") ? match.projectName : p.name,
    };
  });
  return collapseTopLevelProjects(enriched);
}
