export type MobileGitProvider = "github" | "gitlab";

export interface ProviderProject {
  id: string;
  provider: MobileGitProvider;
  name: string;
  fullName: string;
  cloneUrl: string;
  webUrl: string;
  defaultBranch: string;
  isPrivate: boolean;
  updatedAt?: string;
}

export function providerProjectsRequest(provider: MobileGitProvider, token: string): { url: string; headers: Record<string, string> } {
  if (provider === "github") {
    return {
      url: "https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&sort=updated",
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
    };
  }
  return {
    url: "https://gitlab.com/api/v4/projects?membership=true&simple=true&per_page=100&order_by=last_activity_at&sort=desc",
    headers: { Accept: "application/json", "PRIVATE-TOKEN": token },
  };
}

export function parseProviderProjects(provider: MobileGitProvider, payload: unknown): ProviderProject[] {
  if (!Array.isArray(payload)) return [];
  if (provider === "github") {
    return payload.flatMap((raw: any) => {
      const fullName = String(raw?.full_name || "").trim();
      const cloneUrl = String(raw?.clone_url || "").trim();
      if (!fullName || !cloneUrl) return [];
      return [{
        id: `github:${String(raw.id ?? fullName)}`,
        provider,
        name: String(raw.name || fullName.split("/").pop() || fullName),
        fullName,
        cloneUrl,
        webUrl: String(raw.html_url || cloneUrl.replace(/\.git$/i, "")),
        defaultBranch: String(raw.default_branch || "main"),
        isPrivate: Boolean(raw.private),
        updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : undefined,
      }];
    });
  }
  return payload.flatMap((raw: any) => {
    const fullName = String(raw?.path_with_namespace || "").trim();
    const cloneUrl = String(raw?.http_url_to_repo || "").trim();
    if (!fullName || !cloneUrl) return [];
    return [{
      id: `gitlab:${String(raw.id ?? fullName)}`,
      provider,
      name: String(raw.name || fullName.split("/").pop() || fullName),
      fullName,
      cloneUrl,
      webUrl: String(raw.web_url || cloneUrl.replace(/\.git$/i, "")),
      defaultBranch: String(raw.default_branch || "main"),
      isPrivate: String(raw.visibility || "private") !== "public",
      updatedAt: typeof raw.last_activity_at === "string" ? raw.last_activity_at : undefined,
    }];
  });
}
