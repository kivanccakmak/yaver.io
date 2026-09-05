import { collapseTopLevelProjects, pathIsInside, projectPathsEqual } from "./projectTopLevel";

export interface ProjectInventoryRow {
  name: string;
  path: string;
  branch?: string;
  framework?: string;
  frameworks?: string[];
  stack?: string;
  stacks?: string[];
  surfaces?: string[];
  testSurfaces?: string[];
  backend?: string;
  services?: string[];
  hosting?: string[];
  role?: string;
  executionMode?: string;
  primarySurface?: string;
  gitRemote?: string;
  tags?: string[];
}

export interface WorkspaceRepoRow {
  name: string;
  path: string;
  branch?: string;
  remote?: string;
  lastCommit?: string;
  dirty?: boolean;
  stack?: {
    type?: string;
    frameworks?: string[];
    services?: string[];
    actions?: string[];
  };
}

function projectFromRepo(repo: WorkspaceRepoRow): ProjectInventoryRow {
  const frameworks = repo.stack?.frameworks ?? [];
  const services = repo.stack?.services ?? [];
  const actions = repo.stack?.actions ?? [];
  const stackType = repo.stack?.type;
  const framework = stackType === "monorepo" ? "monorepo" : frameworks[0] || stackType || "repo";
  const surfaces = new Set<string>();
  const lower = new Set([stackType, ...frameworks, ...actions].filter(Boolean).map((v) => String(v).toLowerCase()));
  if (lower.has("monorepo")) {
    surfaces.add("web");
    surfaces.add("mobile");
    surfaces.add("backend");
  }
  if (["expo", "react-native", "flutter", "swift", "kotlin", "mobile"].some((v) => lower.has(v))) surfaces.add("mobile");
  if (["next.js", "nextjs", "vite", "react", "web", "dev-server"].some((v) => lower.has(v))) surfaces.add("web");
  if (["go", "python", "rust", "backend"].some((v) => lower.has(v))) surfaces.add("backend");
  return {
    name: repo.name || repo.path.split(/[\\/]/).filter(Boolean).pop() || repo.path,
    path: repo.path,
    branch: repo.branch,
    framework,
    frameworks,
    stack: stackType,
    stacks: [stackType, ...frameworks].filter(Boolean) as string[],
    surfaces: Array.from(surfaces),
    services,
    hosting: services.filter((v) => ["cloudflare", "vercel", "netlify"].includes(v)),
    role: stackType === "monorepo" ? "repo" : stackType || "repo",
    executionMode: actions.includes("hot-reload") ? "native-webrtc" : actions.includes("dev-server") ? "web" : undefined,
    primarySurface: surfaces.has("web") ? "web" : surfaces.has("mobile") ? "mobile" : stackType,
    gitRemote: repo.remote,
    tags: [stackType, ...frameworks, ...services, ...actions, repo.dirty ? "dirty" : undefined].filter(Boolean) as string[],
  };
}

/**
 * Merge the canonical /projects inventory with the lightweight /repos/list
 * supplement without letting a broad container directory erase real Git
 * roots. The agent discovers repositories from their `.git` entries; the
 * supplement may add a missing sibling, but a supplement-only ancestor of a
 * canonical project is never a selectable project itself.
 *
 * This is path-shape based and has no knowledge of usernames, HOME layouts,
 * operating systems, or conventional checkout folder names.
 */
export function mergeProjectInventory(
  projects: ProjectInventoryRow[],
  repos: WorkspaceRepoRow[],
): ProjectInventoryRow[] {
  const canonical = projects.filter((project) => Boolean(project.path));
  const byPath = new Map<string, ProjectInventoryRow>();
  for (const project of canonical) byPath.set(project.path, project);

  for (const repo of repos) {
    if (!repo.path || byPath.has(repo.path) || canonical.some((project) => projectPathsEqual(project.path, repo.path))) continue;
    if (canonical.some((project) => pathIsInside(project.path, repo.path))) continue;
    byPath.set(repo.path, projectFromRepo(repo));
  }

  return collapseTopLevelProjects(Array.from(byPath.values()));
}
