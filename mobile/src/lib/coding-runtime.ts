import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "./secure-storage";
import * as FileSystem from "expo-file-system";
import git from "isomorphic-git/index.js";
import http from "isomorphic-git/http/web";

export type RuntimeKind = "remote-agent" | "local-yaver" | "cloud" | "ci";
export type CodingMode = "remote-preferred" | "local-only" | "auto-fallback";
export type LlmProvider = "deepseek" | "openai-compatible" | "ollama";
export type GitProvider = "github" | "gitlab";
export type GitHost = GitProvider | "other";

export interface RuntimeCapabilities {
  filesystem: boolean; search: boolean; gitRead: boolean; gitWrite: boolean;
  network: boolean; shell: boolean; processes: boolean; docker: boolean;
  browserAutomation: boolean; nativeBuild: boolean; deploy: boolean;
  ciDispatch: boolean; remoteHandoff: boolean;
}

export const LOCAL_CAPABILITIES: RuntimeCapabilities = {
  filesystem: true, search: true, gitRead: true, gitWrite: true, network: true,
  shell: false, processes: false, docker: false, browserAutomation: false,
  nativeBuild: false, deploy: false, ciDispatch: true, remoteHandoff: true,
};

export const REMOTE_CAPABILITIES: RuntimeCapabilities = {
  filesystem: true, search: true, gitRead: true, gitWrite: true, network: true,
  shell: true, processes: true, docker: true, browserAutomation: true,
  nativeBuild: true, deploy: true, ciDispatch: true, remoteHandoff: true,
};

export interface LocalWorkspace {
  id: string;
  name: string;
  root: string;
  repoUrl?: string;
  provider?: GitHost;
  repoPath?: string;
  branch: string;
  baseCommit?: string;
  dirty?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface LocalTaskResult {
  text: string;
  provider: LlmProvider;
  model: string;
  runtime: RuntimeKind;
  changedFiles: string[];
}

const MODE_KEY = "@yaver/coding_mode";
const PROVIDER_KEY = "@yaver/local_provider";
const MODEL_KEY = "@yaver/local_model";
const WORKSPACES_KEY = "@yaver/local_workspaces";
const SECRET_PREFIX = "yaver.local.api-key.";
const GIT_SECRET_PREFIX = "yaver.git-token.";
const WORKSPACE_DIR = `${FileSystem.documentDirectory || ""}yaver-workspaces/`;

const fs: any = {
  async readFile(path: string, options?: { encoding?: string }) {
    const data = await FileSystem.readAsStringAsync(path, { encoding: FileSystem.EncodingType.UTF8 });
    return options?.encoding === "utf8" || !options?.encoding ? data : data;
  },
  async writeFile(path: string, data: string | Uint8Array) {
    await ensureDir(path.slice(0, path.lastIndexOf("/")));
    await FileSystem.writeAsStringAsync(path, typeof data === "string" ? data : new TextDecoder().decode(data), { encoding: FileSystem.EncodingType.UTF8 });
  },
  async readdir(path: string) {
    const entries = await FileSystem.readDirectoryAsync(path);
    return entries;
  },
  async stat(path: string) {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) throw new Error(`Not found: ${path}`);
    return { isFile: () => !info.isDirectory, isDirectory: () => !!info.isDirectory, size: info.size || 0, mode: 0o100644, mtimeMs: Date.now() };
  },
  async lstat(path: string) { return this.stat(path); },
  async mkdir(path: string) { await ensureDir(path); },
  async unlink(path: string) { await FileSystem.deleteAsync(path, { idempotent: true }); },
  async rmdir(path: string) { await FileSystem.deleteAsync(path, { idempotent: true }); },
  async rename(oldPath: string, newPath: string) { await ensureDir(newPath.slice(0, newPath.lastIndexOf("/"))); await FileSystem.moveAsync({ from: oldPath, to: newPath }); },
};

async function ensureDir(path: string): Promise<void> {
  if (!path) return;
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) await FileSystem.makeDirectoryAsync(path, { intermediates: true });
}

export async function getCodingMode(): Promise<CodingMode> {
  const value = await AsyncStorage.getItem(MODE_KEY);
  return value === "local-only" || value === "auto-fallback" ? value : "remote-preferred";
}
export async function setCodingMode(mode: CodingMode): Promise<void> { await AsyncStorage.setItem(MODE_KEY, mode); }
export async function getLocalProvider(): Promise<LlmProvider> {
  const value = await AsyncStorage.getItem(PROVIDER_KEY);
  return value === "openai-compatible" || value === "ollama" ? value : "deepseek";
}
export async function setLocalProvider(provider: LlmProvider): Promise<void> { await AsyncStorage.setItem(PROVIDER_KEY, provider); }
export async function getLocalModel(): Promise<string> { return (await AsyncStorage.getItem(MODEL_KEY)) || "deepseek-chat"; }
export async function setLocalModel(model: string): Promise<void> { await AsyncStorage.setItem(MODEL_KEY, model.trim() || "deepseek-chat"); }
export async function getLocalApiKey(provider: LlmProvider): Promise<string> { return (await SecureStore.getSecret(SECRET_PREFIX + provider)) || ""; }
export async function setLocalApiKey(provider: LlmProvider, key: string): Promise<void> { key.trim() ? await SecureStore.setSecret(SECRET_PREFIX + provider, key.trim()) : await SecureStore.deleteSecret(SECRET_PREFIX + provider); }
export async function getGitToken(provider: GitProvider): Promise<string> { return (await SecureStore.getSecret(GIT_SECRET_PREFIX + provider)) || ""; }
export async function setGitToken(provider: GitProvider, token: string): Promise<void> { token.trim() ? await SecureStore.setSecret(GIT_SECRET_PREFIX + provider, token.trim()) : await SecureStore.deleteSecret(GIT_SECRET_PREFIX + provider); }

export async function listLocalWorkspaces(): Promise<LocalWorkspace[]> {
  try { return JSON.parse((await AsyncStorage.getItem(WORKSPACES_KEY)) || "[]"); } catch { return []; }
}
export async function saveLocalWorkspace(workspace: LocalWorkspace): Promise<void> {
  const all = await listLocalWorkspaces();
  await AsyncStorage.setItem(WORKSPACES_KEY, JSON.stringify([...all.filter((item) => item.id !== workspace.id), workspace]));
}

function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace"; }
function repoPathFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const parts = url.replace(/\.git$/, "").split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : undefined;
}

export async function createLocalWorkspace(input: { name: string; repoUrl?: string; provider?: GitHost; branch?: string }): Promise<LocalWorkspace> {
  const now = Date.now();
  const id = `local-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const workspace: LocalWorkspace = { id, name: input.name.trim(), root: `${WORKSPACE_DIR}${id}/`, repoUrl: input.repoUrl?.trim() || undefined, provider: input.provider, repoPath: repoPathFromUrl(input.repoUrl), branch: input.branch || "main", createdAt: now, updatedAt: now };
  await ensureDir(workspace.root);
  if (!workspace.repoUrl) {
    await git.init({ fs, dir: workspace.root, defaultBranch: workspace.branch });
    await fs.writeFile(`${workspace.root}README.md`, `# ${workspace.name}\n\nCreated in Yaver phone-only mode.\n`);
    await git.add({ fs, dir: workspace.root, filepath: "README.md" });
    await git.commit({ fs, dir: workspace.root, message: "Initialize Yaver workspace", author: { name: "Yaver", email: "yaver@localhost" } });
  }
  await saveLocalWorkspace(workspace);
  return workspace;
}

async function authFor(provider: GitProvider): Promise<{ username: string; password: string }> {
  const token = await getGitToken(provider);
  if (!token) throw new Error(`Add your ${provider === "github" ? "GitHub" : "GitLab"} token in Settings first.`);
  return provider === "github" ? { username: "x-access-token", password: token } : { username: "oauth2", password: token };
}

function gitUrl(workspace: LocalWorkspace): string {
  if (!workspace.repoUrl) throw new Error("This workspace has no repository URL.");
  return workspace.repoUrl.endsWith(".git") ? workspace.repoUrl : `${workspace.repoUrl}.git`;
}

export async function cloneWorkspace(workspace: LocalWorkspace): Promise<LocalWorkspace> {
  if (!workspace.repoUrl || !workspace.provider || workspace.provider === "other") throw new Error("A GitHub or GitLab repository URL is required.");
  const auth = await authFor(workspace.provider);
  await ensureDir(workspace.root);
  await git.clone({ fs, http, dir: workspace.root, url: gitUrl(workspace), singleBranch: true, depth: 1, onAuth: () => auth } as any);
  const branch = await git.currentBranch({ fs, dir: workspace.root, fullname: false }) || workspace.branch;
  const baseCommit = await git.resolveRef({ fs, dir: workspace.root, ref: branch });
  const updated = { ...workspace, branch, baseCommit, updatedAt: Date.now(), dirty: false };
  await saveLocalWorkspace(updated);
  return updated;
}

export async function readWorkspaceFile(workspace: LocalWorkspace, path: string): Promise<string> {
  const safe = path.replace(/^\/+/, "");
  if (safe.includes("..")) throw new Error("Invalid workspace path");
  return fs.readFile(`${workspace.root}${safe}`, { encoding: "utf8" }) as Promise<string>;
}
export async function writeWorkspaceFile(workspace: LocalWorkspace, path: string, content: string): Promise<void> {
  const safe = path.replace(/^\/+/, "");
  if (safe.includes("..")) throw new Error("Invalid workspace path");
  await fs.writeFile(`${workspace.root}${safe}`, content);
  await saveLocalWorkspace({ ...workspace, dirty: true, updatedAt: Date.now() });
}
export async function searchWorkspace(workspace: LocalWorkspace, query: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string, relative: string) {
    for (const name of await fs.readdir(dir)) {
      if (name === ".git" || name === "node_modules") continue;
      const path = `${dir}${name}`, rel = `${relative}${name}`;
      const stat = await fs.stat(path);
      if (stat.isDirectory()) await walk(`${path}/`, `${rel}/`);
      else if (String(await fs.readFile(path, { encoding: "utf8" })).toLowerCase().includes(query.toLowerCase())) result.push(rel);
    }
  }
  await walk(workspace.root, "");
  return result;
}

export async function gitStatus(workspace: LocalWorkspace): Promise<{ branch: string; current: string; changes: string[] }> {
  const current = await git.currentBranch({ fs, dir: workspace.root, fullname: false }) || workspace.branch;
  const matrix = await git.statusMatrix({ fs, dir: workspace.root });
  return { branch: current, current: await git.resolveRef({ fs, dir: workspace.root, ref: current }), changes: matrix.filter(([, head, workdir, stage]) => head !== workdir || workdir !== stage).map(([path]) => path) };
}
export async function gitDiff(workspace: LocalWorkspace): Promise<string> {
  const status = await gitStatus(workspace);
  return status.changes.map((path) => `${path}: modified`).join("\n");
}
export async function gitCommit(workspace: LocalWorkspace, message: string): Promise<string> {
  const status = await gitStatus(workspace);
  if (!status.changes.length) throw new Error("There are no changes to commit.");
  for (const path of status.changes) await git.add({ fs, dir: workspace.root, filepath: path });
  const sha = await git.commit({ fs, dir: workspace.root, message, author: { name: "Yaver", email: "yaver@localhost" } });
  await saveLocalWorkspace({ ...workspace, baseCommit: sha, dirty: false, updatedAt: Date.now() });
  return sha;
}
export async function gitPush(workspace: LocalWorkspace): Promise<void> {
  if (!workspace.provider || workspace.provider === "other") throw new Error("Git push requires GitHub or GitLab credentials.");
  await git.push({ fs, http, dir: workspace.root, remote: "origin", ref: workspace.branch, onAuth: () => authFor(workspace.provider as GitProvider) } as any);
  await saveLocalWorkspace({ ...workspace, baseCommit: await git.resolveRef({ fs, dir: workspace.root, ref: workspace.branch }), dirty: false, updatedAt: Date.now() });
}

/** Backwards-compatible task action: make a real local commit, then push it. */
export async function pushWorkspace(_provider: GitProvider, _ownerOrNamespace: string, workspace: LocalWorkspace, message: string): Promise<void> {
  // Phone-local edits are never pushed directly to the checked-out branch.
  // Create a review branch first; a PR can then be opened in the provider UI.
  const current = await git.currentBranch({ fs, dir: workspace.root, fullname: false }) || workspace.branch;
  const reviewBranch = `yaver/local-${Date.now().toString(36)}`;
  await git.branch({ fs, dir: workspace.root, ref: reviewBranch, object: current });
  await git.checkout({ fs, dir: workspace.root, ref: reviewBranch });
  workspace = { ...workspace, branch: reviewBranch, updatedAt: Date.now() };
  const status = await gitStatus(workspace);
  if (status.changes.length) await gitCommit(workspace, message);
  await gitPush(workspace);
}

export async function createGitRepository(provider: GitProvider, name: string, isPrivate = true): Promise<string> {
  const token = await getGitToken(provider);
  if (!token) throw new Error(`Add your ${provider === "github" ? "GitHub" : "GitLab"} token in Settings first.`);
  const response = await fetch(provider === "github" ? "https://api.github.com/user/repos" : "https://gitlab.com/api/v4/projects", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/vnd.github+json", ...(provider === "github" ? { Authorization: `Bearer ${token}` } : { "PRIVATE-TOKEN": token }) }, body: JSON.stringify(provider === "github" ? { name, private: isPrivate } : { name, visibility: isPrivate ? "private" : "public" }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || data?.error || `Could not create repository (HTTP ${response.status}).`);
  return data.html_url || data.web_url || data.http_url_to_repo;
}

const endpoint = (provider: LlmProvider) => provider === "deepseek" ? "https://api.deepseek.com/chat/completions" : provider === "ollama" ? "http://localhost:11434/v1/chat/completions" : "https://api.openai.com/v1/chat/completions";
const tools = [
  { type: "function", function: { name: "fs_read", description: "Read a UTF-8 file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "fs_write", description: "Write a UTF-8 file after user-approved task intent", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "fs_search", description: "Search workspace files", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "git_status", description: "Show Git status", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "git_diff", description: "Show changed files", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "git_commit", description: "Commit current changes; never push without a separate user action", parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } } },
];

async function callModel(provider: LlmProvider, model: string, messages: any[]): Promise<any> {
  const key = await getLocalApiKey(provider);
  if (!key && provider !== "ollama") throw new Error(`Configure a ${provider === "deepseek" ? "DeepSeek" : "OpenAI"} API key in Settings.`);
  const response = await fetch(endpoint(provider), { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ model, messages, tools, tool_choice: "auto", temperature: 0.1 }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `LLM provider returned HTTP ${response.status}`);
  return data.choices?.[0]?.message || {};
}

export async function runLocalPrompt(prompt: string, workspace: LocalWorkspace): Promise<LocalTaskResult> {
  const provider = await getLocalProvider();
  const model = await getLocalModel();
  const messages: any[] = [{ role: "system", content: `You are Yaver Local, a device-local coding assistant. Work only through the tools provided.

You CAN: read/search/write files in this workspace; inspect Git status and changed files; create a local Git commit when explicitly asked.

You CANNOT: run shell commands; run npm, npx, yarn, pnpm, bun, pip, ruby, gradle, xcodebuild, pod, fastlane, or any package manager; start servers; install dependencies; use Docker; access a simulator/emulator/device; compile, test, lint, typecheck, build iOS/Android/web/native apps; browse; deploy; push Git; create pull requests; or execute OpenCode/Codex.

For an iOS, Android, TV, or dependency/test/build request, make safe source edits if appropriate, then clearly say: "Not executed — device-local Yaver has no shell or native build runtime." State the exact command or CI job the user should run later, but never claim it ran or infer a pass/fail result. Do not invent tool output, files, dependencies, commit SHAs, test results, screenshots, or external state. Prefer a small reviewable diff. Before a destructive or broad edit, explain the intended change and ask for confirmation.` }, { role: "user", content: prompt }];
  const changed = new Set<string>();
  for (let turn = 0; turn < 8; turn++) {
    const message = await callModel(provider, model, messages);
    messages.push(message);
    if (!message.tool_calls?.length) return { text: message.content || "Done.", provider, model, runtime: "local-yaver", changedFiles: [...changed] };
    for (const call of message.tool_calls) {
      const args = JSON.parse(call.function.arguments || "{}");
      let result: unknown;
      try {
        if (call.function.name === "fs_read") result = await readWorkspaceFile(workspace, args.path);
        else if (call.function.name === "fs_write") { await writeWorkspaceFile(workspace, args.path, args.content); changed.add(args.path); result = { ok: true, path: args.path }; }
        else if (call.function.name === "fs_search") result = await searchWorkspace(workspace, args.query);
        else if (call.function.name === "git_status") result = await gitStatus(workspace);
        else if (call.function.name === "git_diff") result = await gitDiff(workspace);
        else if (call.function.name === "git_commit") result = { sha: await gitCommit(workspace, args.message) };
        else result = { error: "Unknown tool" };
      } catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return { text: "The local agent reached its safe tool-call limit. Review the diff and continue or hand off to a remote runtime.", provider, model, runtime: "local-yaver", changedFiles: [...changed] };
}
