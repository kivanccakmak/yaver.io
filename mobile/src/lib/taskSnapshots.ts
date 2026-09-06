import { getToken } from "./auth";
import { getConvexSiteUrlSync } from "./backendConfig";
import type { TaskStatus } from "./quic";

export interface AgentTaskLifecycle {
  taskId: string;
  yaverSessionId?: string;
  status: TaskStatus;
  hostKind?: "terminal_tmux" | "desktop_gui" | "runner_process";
  updatedAt: number;
}

export interface AgentTaskSnapshot {
  deviceId: string;
  deviceName: string;
  deviceOnline: boolean;
  deviceLastHeartbeat: number;
  observedAt: number;
  tasks: AgentTaskLifecycle[];
}

/** Prompt-free session addresses published by each Go agent. Descriptive task
 * content is fetched from that agent P2P after the user opens the session. */
export async function listAgentTaskSnapshots(): Promise<AgentTaskSnapshot[]> {
  const token = await getToken();
  if (!token) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${getConvexSiteUrlSync()}/task-snapshots`, {
      signal: controller.signal,
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(payload?.error || `Failed to synchronize sessions (${response.status})`);
    return Array.isArray(payload) ? payload as AgentTaskSnapshot[] : [];
  } finally {
    clearTimeout(timeout);
  }
}
