import { CONVEX_URL } from "@/lib/constants";

// tmux-sessions.ts — web client for the Convex tmux runner-session ledger
// (backend/convex/tmuxSessions.ts + GET /tmux-sessions).
//
// Cross-device + offline roster: "which machines have which runner seats
// (claude/codex/opencode), open or closed?" — readable without a P2P
// connection. The rich per-pane data still comes from the connected agent's
// /tmux/sessions; this ledger is inventory + lifecycle truth that survives
// agent restarts and reaches every surface. Identifiers + lifecycle only.

export type TmuxRunnerStatus = "open" | "closed";

export type TmuxRunnerLabel = "claude" | "codex" | "opencode" | "shell" | "unknown";

export interface TmuxRunnerSessionRecord {
  deviceId: string;
  deviceName: string;
  deviceOnline: boolean;
  sessionName: string;
  sessionId?: string;
  paneId?: string;
  runner: TmuxRunnerLabel;
  status: TmuxRunnerStatus;
  paneCount?: number;
  firstSeenAt: number;
  lastSeenAt: number;
  closedAt?: number;
}

/** A real coding-agent seat — the ones worth surfacing for vibing. */
export function isRunnerSeat(r: Pick<TmuxRunnerSessionRecord, "runner">): boolean {
  return r.runner === "claude" || r.runner === "codex" || r.runner === "opencode";
}

/** List the caller's tmux runner sessions across every device. Bounded (10s)
 *  so a hung backend can't hold up the dashboard. */
export async function listTmuxRunnerSessions(
  token: string,
  opts: { deviceId?: string; status?: TmuxRunnerStatus } = {},
): Promise<TmuxRunnerSessionRecord[]> {
  if (!token) throw new Error("Not signed in");
  const params = new URLSearchParams();
  if (opts.deviceId) params.set("deviceId", opts.deviceId);
  if (opts.status) params.set("status", opts.status);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(`${CONVEX_URL}/tmux-sessions${suffix}`, {
      signal: controller.signal,
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new Error(data?.error || `Failed to list tmux sessions (${res.status})`);
  }
  return (data ?? []) as TmuxRunnerSessionRecord[];
}
