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

/** Credentials are configured only on an execution-capable endpoint. Convex may
 * persist a runner/model preference, but never a provider key, OAuth token,
 * Git token, or refresh token. */
export type CredentialAuthority = "device-secure-store" | "desktop-secret-store" | "worker-secret-store" | "none";

export function credentialAuthority(surface: SurfaceKind, state: RuntimeState): CredentialAuthority {
  if ((surface === "mobile" || surface === "tv") && state === "local") return "device-secure-store";
  if (state === "remote") return "desktop-secret-store";
  if (state === "cloud") return "worker-secret-store";
  return "none";
}

export interface CompanionCommand {
  type: "status" | "stop" | "retry" | "approve" | "review" | "start_local";
  sessionId?: string;
  payload?: Record<string, unknown>;
}

export const COMPANION_CAPABILITIES: Record<"watch" | "car" | "tv" | "xr", RuntimeCapabilities> = {
  watch: { filesystem: false, search: false, gitRead: false, gitWrite: false, network: true, shell: false, processes: false, docker: false, browserAutomation: false, nativeBuild: false, deploy: false, ciDispatch: true, remoteHandoff: true },
  car: { filesystem: false, search: false, gitRead: false, gitWrite: false, network: true, shell: false, processes: false, docker: false, browserAutomation: false, nativeBuild: false, deploy: false, ciDispatch: true, remoteHandoff: true },
  tv: { filesystem: true, search: true, gitRead: true, gitWrite: true, network: true, shell: false, processes: false, docker: false, browserAutomation: false, nativeBuild: false, deploy: false, ciDispatch: true, remoteHandoff: true },
  xr: { filesystem: true, search: true, gitRead: true, gitWrite: true, network: true, shell: false, processes: false, docker: false, browserAutomation: false, nativeBuild: false, deploy: false, ciDispatch: true, remoteHandoff: true },
};

/**
 * Capability ceiling when no desktop, cloud worker, CI runner, or Android shell
 * bridge is reachable. This is deliberately separate from companion capabilities:
 * it prevents an offline surface from presenting a remote-only action as if it
 * could execute it locally.
 */
export const OFFLINE_ONLY_CAPABILITIES: Record<SurfaceKind, RuntimeCapabilities> = {
  // iOS/Android phone workspace: direct provider API plus file/Git operations;
  // never a shell, OpenCode/Codex process, Docker, or native build runtime.
  mobile: { filesystem: true, search: true, gitRead: true, gitWrite: true, network: true, shell: false, processes: false, docker: false, browserAutomation: false, nativeBuild: false, deploy: false, ciDispatch: false, remoteHandoff: false },
  // Browser workspace is intentionally constrained to client-side editing.
  web: { filesystem: false, search: false, gitRead: false, gitWrite: false, network: true, shell: false, processes: false, docker: false, browserAutomation: false, nativeBuild: false, deploy: false, ciDispatch: false, remoteHandoff: false },
  desktop: { filesystem: false, search: false, gitRead: false, gitWrite: false, network: false, shell: false, processes: false, docker: false, browserAutomation: false, nativeBuild: false, deploy: false, ciDispatch: false, remoteHandoff: false },
  // Companion surfaces may compose a task draft locally, but cannot execute it.
  watch: { filesystem: false, search: false, gitRead: false, gitWrite: false, network: false, shell: false, processes: false, docker: false, browserAutomation: false, nativeBuild: false, deploy: false, ciDispatch: false, remoteHandoff: false },
  car: { filesystem: false, search: false, gitRead: false, gitWrite: false, network: false, shell: false, processes: false, docker: false, browserAutomation: false, nativeBuild: false, deploy: false, ciDispatch: false, remoteHandoff: false },
  // A signed tvOS build may provide a direct model API and app-sandbox Git
  // workspace. It requires device-local secure storage; there is no shell,
  // OpenCode/Codex process, Docker, build, or background worker.
  tv: { filesystem: true, search: true, gitRead: true, gitWrite: true, network: true, shell: false, processes: false, docker: false, browserAutomation: false, nativeBuild: false, deploy: false, ciDispatch: false, remoteHandoff: false },
  xr: { filesystem: false, search: false, gitRead: false, gitWrite: false, network: false, shell: false, processes: false, docker: false, browserAutomation: false, nativeBuild: false, deploy: false, ciDispatch: false, remoteHandoff: false },
};
