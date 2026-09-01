import { getToken } from "./auth";
import { getConvexSiteUrlSync } from "./backendConfig";

// tmuxRunnerSessions.ts — mobile client for the Convex tmux runner-session
// ledger (backend/convex/tmuxSessions.ts + GET /tmux-sessions).
//
// This is the CROSS-DEVICE + OFFLINE roster: "which machines have which runner
// seats (claude/codex/opencode), open or closed?" — readable without a P2P
// connection to any agent. The rich per-pane data (preview, status, taskId)
// still comes from the connected agent's /tmux/sessions; this ledger is the
// inventory + lifecycle truth that survives agent restarts and reaches every
// device. Identifiers + bounded session identity + lifecycle only — no pane
// content, paths, or prompts.

export type TmuxRunnerStatus = "open" | "closed";

export type TmuxRunnerLabel = "claude" | "codex" | "opencode" | "shell" | "unknown";

export interface TmuxRunnerSessionRecord {
  deviceId: string;
  deviceName: string;
  deviceOnline: boolean;
  sessionName: string;
  sessionId?: string;
  paneId?: string;
  sessionKind?: "task" | "autorun" | "runner" | "other";
  origin?: "yaver-task" | "yaver-autorun" | "yaver-runner" | "manual";
  projectHint?: string;
  taskId?: string;
  taskIdHint?: string;
  inputMode?: "interactive" | "task-followup";
  runner: TmuxRunnerLabel;
  status: TmuxRunnerStatus;
  paneCount?: number;
  startedAt?: number;
  firstSeenAt: number;
  lastSeenAt: number;
  closedAt?: number;
}

/** A real coding-agent seat — the ones worth surfacing for vibing. */
export function isRunnerSeat(r: Pick<TmuxRunnerSessionRecord, "runner">): boolean {
  return r.runner === "claude" || r.runner === "codex" || r.runner === "opencode";
}

/** List the caller's tmux runner sessions across every device. */
export async function listTmuxRunnerSessions(opts: {
  deviceId?: string;
  status?: TmuxRunnerStatus;
} = {}): Promise<TmuxRunnerSessionRecord[]> {
  const token = await getToken();
  if (!token) throw new Error("Not signed in");
  const params = new URLSearchParams();
  if (opts.deviceId) params.set("deviceId", opts.deviceId);
  if (opts.status) params.set("status", opts.status);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(`${getConvexSiteUrlSync()}/tmux-sessions${suffix}`, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error("Timed out loading runner sessions");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new Error(data?.error || `Failed to list Yaver sessions (${res.status})`);
  }
  return (data ?? []) as TmuxRunnerSessionRecord[];
}

/** One-line label: "claude · yaver-test · open". */
export function tmuxRunnerSessionLabel(r: Pick<TmuxRunnerSessionRecord, "runner" | "sessionName" | "status">): string {
  return `${r.runner} · ${r.sessionName} · ${r.status}`;
}
