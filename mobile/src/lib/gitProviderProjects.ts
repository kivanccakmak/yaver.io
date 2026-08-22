// Read-only repository discovery using credentials already stored on this
// phone. Tokens never leave request headers, never enter Convex, and are never
// included in returned rows or errors.

import { loadProviderToken } from "./gitProviderStore";
import {
  parseProviderProjects,
  providerProjectsRequest,
  type MobileGitProvider,
  type ProviderProject,
} from "./gitProviderProjectsCore";

export type { MobileGitProvider, ProviderProject } from "./gitProviderProjectsCore";

export interface ConnectedProviderProjectsResult {
  projects: ProviderProject[];
  errors: string[];
}

export async function listProviderProjects(provider: MobileGitProvider, timeoutMs = 8000): Promise<ProviderProject[]> {
  const token = await loadProviderToken(provider);
  if (!token) return [];
  const request = providerProjectsRequest(provider, token);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(request.url, { headers: request.headers, signal: controller.signal });
    if (!response.ok) throw new Error(`${provider === "github" ? "GitHub" : "GitLab"} project list failed (HTTP ${response.status}). Reconnect it in Settings.`);
    return parseProviderProjects(provider, await response.json());
  } finally {
    clearTimeout(timer);
  }
}

export async function listConnectedProviderProjects(): Promise<ProviderProject[]> {
  return (await discoverConnectedProviderProjects()).projects;
}

export async function discoverConnectedProviderProjects(): Promise<ConnectedProviderProjectsResult> {
  const results = await Promise.allSettled([listProviderProjects("github"), listProviderProjects("gitlab")]);
  const rows = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const errors = results.flatMap((result) => result.status === "rejected"
    ? [result.reason instanceof Error ? result.reason.message : "A connected Git provider could not list projects."]
    : []);
  return {
    projects: rows.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))),
    errors,
  };
}
