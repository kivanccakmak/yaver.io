import assert from "node:assert/strict";
import test from "node:test";

import { parseProviderProjects, providerProjectsRequest } from "./gitProviderProjectsCore.ts";

test("GitHub project discovery keeps only clone-safe metadata", () => {
  const rows = parseProviderProjects("github", [{ id: 7, name: "app", full_name: "team/app", clone_url: "https://github.com/team/app.git", html_url: "https://github.com/team/app", default_branch: "trunk", private: true, updated_at: "2026-08-22" }]);
  assert.deepEqual(rows[0], { id: "github:7", provider: "github", name: "app", fullName: "team/app", cloneUrl: "https://github.com/team/app.git", webUrl: "https://github.com/team/app", defaultBranch: "trunk", isPrivate: true, updatedAt: "2026-08-22" });
  assert.equal("token" in rows[0], false);
});

test("GitLab project discovery normalizes namespace and visibility", () => {
  const rows = parseProviderProjects("gitlab", [{ id: 9, name: "api", path_with_namespace: "group/api", http_url_to_repo: "https://gitlab.com/group/api.git", web_url: "https://gitlab.com/group/api", default_branch: "main", visibility: "public" }]);
  assert.equal(rows[0]?.fullName, "group/api");
  assert.equal(rows[0]?.isPrivate, false);
});

test("provider requests keep credentials in headers", () => {
  const github = providerProjectsRequest("github", "secret-value");
  assert.doesNotMatch(github.url, /secret-value/);
  assert.equal(github.headers.Authorization, "Bearer secret-value");
  const gitlab = providerProjectsRequest("gitlab", "secret-value");
  assert.doesNotMatch(gitlab.url, /secret-value/);
  assert.equal(gitlab.headers["PRIVATE-TOKEN"], "secret-value");
});
