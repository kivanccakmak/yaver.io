export type RuntimeKind = "remote-agent" | "local-yaver" | "cloud" | "ci";
export type CodingMode = "remote-preferred" | "local-only" | "auto-fallback";
export type LlmProvider = "deepseek" | "openai-compatible" | "ollama";
export type GitProvider = "github" | "gitlab";
export type GitHost = GitProvider | "other";

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

export interface StaticValidationIssue {
  severity: "error" | "warning";
  path: string;
  message: string;
}

export interface StaticValidationReport {
  kind: "static-preflight";
  checkedFiles: number;
  changedFiles: string[];
  issues: StaticValidationIssue[];
  compiled: false;
  tested: false;
}

const unavailable = async (): Promise<never> => {
  throw new Error("Local coding is unavailable on tvOS. Use a Cloud Studio Project Session.");
};

export async function getCodingMode(): Promise<CodingMode> { return "remote-preferred"; }
export async function setCodingMode(): Promise<void> { await unavailable(); }
export async function getLocalProvider(): Promise<LlmProvider> { return "deepseek"; }
export async function setLocalProvider(): Promise<void> { await unavailable(); }
export async function getLocalModel(): Promise<string> { return ""; }
export async function setLocalModel(): Promise<void> { await unavailable(); }
export async function getLocalApiKey(): Promise<string> { return ""; }
export async function setLocalApiKey(): Promise<void> { await unavailable(); }
export async function getGitToken(): Promise<string> { return ""; }
export async function setGitToken(): Promise<void> { await unavailable(); }
export async function listLocalWorkspaces(): Promise<LocalWorkspace[]> { return []; }
export const createLocalWorkspace = unavailable;
export const cloneWorkspace = unavailable;
export const pushWorkspace = unavailable;
export const runLocalPrompt = unavailable;
export const validateLocalWorkspace = unavailable;
export const createGitRepository = unavailable;
