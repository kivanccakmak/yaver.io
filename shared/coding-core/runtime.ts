/** Shared surface contract. Execution stays in an adapter; UI must never
 * assume that a shell or native toolchain exists. */
export type RuntimeKind = "remote-agent" | "local-yaver" | "cloud" | "ci";
export type SurfaceKind = "mobile" | "web" | "desktop" | "watch" | "car" | "tv" | "xr";
export type RuntimeState = "connecting" | "remote" | "remote_degraded" | "local" | "cloud" | "ci_only" | "offline";

export interface RuntimeCapabilities {
  filesystem: boolean;
  search: boolean;
  gitRead: boolean;
  gitWrite: boolean;
  network: boolean;
  shell: boolean;
  processes: boolean;
  docker: boolean;
  browserAutomation: boolean;
  nativeBuild: boolean;
  deploy: boolean;
  ciDispatch: boolean;
  remoteHandoff: boolean;
}

export interface WorkspaceIdentity {
  workspaceId: string;
  repoProvider?: "github" | "gitlab" | "other";
  repoId?: string;
  remoteUrl?: string;
  branch: string;
  baseCommit?: string;
  runtimeId: string;
  dirty: boolean;
}

export interface CodingSession {
  id: string;
  surface: SurfaceKind;
  runtime: RuntimeKind;
  state: RuntimeState;
  workspace?: WorkspaceIdentity;
  capabilities: RuntimeCapabilities;
  messages: Array<{ role: "user" | "assistant" | "tool"; content: string; createdAt: number }>;
  updatedAt: number;
}

export interface CompanionCommand {
  type: "status" | "stop" | "retry" | "approve" | "review" | "start_local";
  sessionId?: string;
  payload?: Record<string, unknown>;
}

export const COMPANION_CAPABILITIES: Record<"watch" | "car" | "tv" | "xr", RuntimeCapabilities> = {
  watch: { filesystem: false, search: false, gitRead: false, gitWrite: false, network: true, shell: false, processes: false, docker: false, browserAutomation: false, nativeBuild: false, deploy: false, ciDispatch: true, remoteHandoff: true },
  car: { filesystem: false, search: false, gitRead: false, gitWrite: false, network: true, shell: false, processes: false, docker: false, browserAutomation: false, nativeBuild: false, deploy: false, ciDispatch: true, remoteHandoff: true },
  tv: { filesystem: false, search: false, gitRead: true, gitWrite: false, network: true, shell: false, processes: false, docker: false, browserAutomation: false, nativeBuild: false, deploy: false, ciDispatch: true, remoteHandoff: true },
  xr: { filesystem: true, search: true, gitRead: true, gitWrite: true, network: true, shell: false, processes: false, docker: false, browserAutomation: false, nativeBuild: false, deploy: false, ciDispatch: true, remoteHandoff: true },
};
