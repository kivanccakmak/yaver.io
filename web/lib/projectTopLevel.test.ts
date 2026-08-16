import assert from "node:assert/strict";
import {
  collapseTopLevelProjects,
  isMonorepoAppRow,
  mergeConvexCatalogIntoProjects,
  pathIsInside,
  topLevelDisplayName,
  type TopLevelProject,
} from "./projectTopLevel";

const proj = (path: string, extra: Partial<TopLevelProject> = {}): TopLevelProject => ({
  name: path.split("/").pop() || path,
  path,
  ...extra,
});

// Component-wise — sibling prefixes never collide.
assert.equal(pathIsInside("/ws/yaver.io/mobile", "/ws/yaver.io"), true);
assert.equal(pathIsInside("/ws/yaver.io/mobile/app", "/ws/yaver.io"), true);
assert.equal(pathIsInside("/ws/yaver.io-2", "/ws/yaver.io"), false);
assert.equal(pathIsInside("/ws/yaver.io", "/ws/yaver.io"), false);
assert.equal(pathIsInside("/ws/yaver.io", "/ws/yaver.io/mobile"), false);

// The yaver.io/mobile leak: nested clones fold into their root; only the
// outermost repos surface.
{
  const got = collapseTopLevelProjects([
    proj("/ws/yaver.io/mobile"),
    proj("/ws/yaver.io"),
    proj("/ws/medici.ai"),
    proj("/ws/yaver.io/mobile/app"),
  ]);
  const paths = got.map((p) => p.path).sort();
  assert.deepEqual(paths, ["/ws/medici.ai", "/ws/yaver.io"]);
}

// Siblings that merely share a prefix must all survive.
{
  const got = collapseTopLevelProjects([proj("/ws/yaver.io-2"), proj("/ws/yaver.io"), proj("/ws/yaver.io-mobile")]);
  assert.equal(got.length, 3);
}

// A top-level-only list passes through untouched.
assert.equal(
  collapseTopLevelProjects([proj("/ws/medici.ai"), proj("/ws/yaver.io"), proj("/ws/talos")]).length,
  3,
);

// Monorepo-app labels ("<root> / <app>") never surface as pickable names.
assert.equal(
  isMonorepoAppRow(proj("/ws/yaver.io/mobile", { monorepoApp: "mobile", monorepoRoot: "/ws/yaver.io" })),
  true,
);
assert.equal(
  isMonorepoAppRow(proj("/ws/talos", { name: "talos / frontend", monorepoApp: "frontend", monorepoRoot: "/ws/talos" })),
  true,
);
assert.equal(isMonorepoAppRow(proj("/ws/talos")), false);
assert.equal(
  topLevelDisplayName(proj("/ws/talos", { name: "talos / frontend", monorepoApp: "frontend", monorepoRoot: "/ws/talos" })),
  "talos",
);
assert.equal(topLevelDisplayName(proj("/ws/yaver.io")), "yaver.io");

// Convex catalog merge: agent projects are enriched by catalog rows matched
// on gitRemote / repoName, catalog-only rows are never added (they have no
// path to select), and the result stays top-level only.
{
  const agent = [
    proj("/ws/yaver.io", { gitRemote: "git@github.com:yaver-io/yaver.io.git", branch: undefined }),
    proj("/ws/talos", { gitRemote: "git@gitlab.com:kivanccakmak/talos.git" }),
    proj("/ws/yaver.io/mobile", { gitRemote: "git@github.com:yaver-io/yaver.io.git" }),
  ];
  const catalog = [
    { projectName: "yaver.io", repoName: "yaver.io", gitProvider: "github", gitRemote: "git@github.com:yaver-io/yaver.io.git", branch: "main", framework: "monorepo" },
    // No agent match and no path — must never become a pickable row.
    { projectName: "mystery-app", repoName: "mystery-app", gitProvider: "gitlab", gitRemote: "git@gitlab.com:x/mystery-app.git", branch: "main", framework: "nextjs" },
  ];
  const got = mergeConvexCatalogIntoProjects(agent, catalog);
  const yaver = got.find((p) => p.path === "/ws/yaver.io");
  assert.ok(yaver, "yaver.io must survive the merge");
  assert.equal(yaver.branch, "main", "catalog branch must enrich the agent row");
  assert.equal(yaver.framework, "monorepo", "catalog framework must enrich the agent row");
  assert.equal(got.some((p) => p.path === "/ws/yaver.io/mobile"), false, "nested clone must be collapsed");
  assert.equal(got.some((p) => p.name === "mystery-app"), false, "catalog-only rows without a path must never surface");
}

// A "<root> / <app>" catalog name must never overwrite a top-level name.
{
  const agent = [proj("/ws/talos", { gitRemote: "git@gitlab.com:kivanccakmak/talos.git" })];
  const catalog = [
    { projectName: "talos / frontend", repoName: "talos", gitRemote: "git@gitlab.com:kivanccakmak/talos.git", branch: "dev" },
  ];
  const got = mergeConvexCatalogIntoProjects(agent, catalog);
  assert.equal(got[0].name, "talos", "monorepo-app label must not become the project name");
  assert.equal(got[0].branch, "dev");
}

console.log("web projectTopLevel checks passed");
