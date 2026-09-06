// tmuxSessions.ts — durable tmux runner-session ledger.
//
// The Go agent (desktop/agent/tmux_convex.go) pushes a privacy-safe snapshot of
// every tmux session on each owned device here on its state-sync tick: session
// name, tmux session/pane ids, the bounded structured identity parsed from a
// Yaver session name (kind/start/project/task/input mode), the runner living in
// it (claude/codex/opencode or shell/unknown), and whether that seat is open or closed. Every surface —
// mobile Tasks, web dashboard, TV/watch — can then answer "which machines have
// which runner seats, open or closed?" straight from Convex, without connecting
// P2P to the box, and keep vibing into a session that survived an agent
// restart (adoption state is in-memory on the agent and dies with it).
//
// PRIVACY: identifiers, bounded project/task hints, and lifecycle only. No pane content, no current-path
// (absolute paths leak the home-dir username), no prompts, no titles, no
// models. convex_privacy_test.go fences the agent payload; this module's args
// validator is the second gate.
//
// Auth model:
//   - syncTmuxSessions is a Convex-native compatibility mutation. An opaque
//     Yaver bearer does not authenticate /api/mutation; the active task roster
//     now publishes through the first-class POST /task-snapshots HTTP action.
//   - listTmuxSessions is called by the /tmux-sessions HTTP action with the
//     sha256 of the caller's bearer token (same shape as taskPlacement.ts),
//     so mobile/web can read the ledger without a P2P connection.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { validateSessionInternal } from "./auth";
import { resolveUser } from "./agentSync";

const tmuxSessionStatus = v.union(v.literal("open"), v.literal("closed"));

const tmuxRunner = v.union(
  v.literal("claude"),
  v.literal("codex"),
  v.literal("opencode"),
  v.literal("shell"),
  v.literal("unknown"),
);

const tmuxSessionKind = v.union(
  v.literal("task"),
  v.literal("autorun"),
  v.literal("runner"),
  v.literal("other"),
);

const tmuxInputMode = v.union(v.literal("interactive"), v.literal("task-followup"));

const tmuxOrigin = v.union(
  v.literal("yaver-task"),
  v.literal("yaver-autorun"),
  v.literal("yaver-runner"),
  v.literal("manual"),
);

const tmuxPane = v.object({
  paneId: v.string(),
  runner: tmuxRunner,
  inputMode: v.optional(tmuxInputMode),
  status: tmuxSessionStatus,
});

const sessionArgs = v.object({
  sessionName: v.string(),
  sessionId: v.optional(v.string()),
  paneId: v.optional(v.string()),
  sessionKind: v.optional(tmuxSessionKind),
  origin: v.optional(tmuxOrigin),
  projectHint: v.optional(v.string()),
  taskId: v.optional(v.string()),
  taskIdHint: v.optional(v.string()),
  inputMode: v.optional(tmuxInputMode),
  panes: v.optional(v.array(tmuxPane)),
  runner: tmuxRunner,
  status: tmuxSessionStatus,
  paneCount: v.optional(v.number()),
  startedAt: v.optional(v.number()),
  firstSeenAt: v.optional(v.number()),
  closedAt: v.optional(v.number()),
});

async function userFromToken(ctx: any, tokenHash: string): Promise<Id<"users">> {
  const session = await validateSessionInternal(ctx, tokenHash);
  if (!session) throw new Error("Unauthorized");
  return session.user._id;
}

/** Apply one open session row to the ledger. Closed seats are removed: Convex
 * is the cross-device live index, while history remains local on the agent. */
async function applySession(
  ctx: any,
  userId: Id<"users">,
  deviceId: string,
  s: {
    sessionName: string;
    sessionId?: string;
    paneId?: string;
    sessionKind?: "task" | "autorun" | "runner" | "other";
    origin?: "yaver-task" | "yaver-autorun" | "yaver-runner" | "manual";
    projectHint?: string;
    taskId?: string;
    taskIdHint?: string;
    inputMode?: "interactive" | "task-followup";
    panes?: Array<{
      paneId: string;
      runner: "claude" | "codex" | "opencode" | "shell" | "unknown";
      inputMode?: "interactive" | "task-followup";
      status: "open" | "closed";
    }>;
    runner: string;
    status: "open" | "closed";
    paneCount?: number;
    startedAt?: number;
    firstSeenAt?: number;
    closedAt?: number;
  },
) {
  const now = Date.now();
  const existing = await ctx.db
    .query("tmuxRunnerSessions")
    .withIndex("by_device_session", (q: any) =>
      q.eq("deviceId", deviceId).eq("sessionName", s.sessionName),
    )
    .first();

  if (s.status === "closed") {
    if (existing) {
      await ctx.db.delete(existing._id);
    }
    return;
  }

  // open
  if (existing) {
    await ctx.db.patch(existing._id, {
      sessionId: s.sessionId,
      paneId: s.paneId,
      sessionKind: s.sessionKind ?? existing.sessionKind,
      origin: s.origin ?? existing.origin,
      projectHint: s.projectHint ?? existing.projectHint,
      taskId: s.taskId ?? existing.taskId,
      taskIdHint: s.taskIdHint ?? existing.taskIdHint,
      inputMode: s.inputMode ?? existing.inputMode,
      panes: s.panes ?? existing.panes,
      runner: s.runner === "unknown" ? existing.runner : s.runner,
      status: "open",
      paneCount: s.paneCount ?? existing.paneCount,
      startedAt: s.startedAt ?? existing.startedAt,
      // A reopened seat stops being closed.
      ...(existing.status === "closed" ? { closedAt: undefined } : {}),
      lastSeenAt: now,
    });
  } else {
    await ctx.db.insert("tmuxRunnerSessions", {
      userId,
      deviceId,
      sessionName: s.sessionName,
      sessionId: s.sessionId,
      paneId: s.paneId,
      sessionKind: s.sessionKind,
      origin: s.origin,
      projectHint: s.projectHint,
      taskId: s.taskId,
      taskIdHint: s.taskIdHint,
      inputMode: s.inputMode,
      panes: s.panes,
      runner: s.runner === "unknown" ? "unknown" : s.runner,
      status: "open",
      paneCount: s.paneCount,
      startedAt: s.startedAt,
      firstSeenAt: s.firstSeenAt ?? now,
      lastSeenAt: now,
    });
  }
}

/** Agent-facing: reconcile this device's tmux session ledger. Best-effort —
 *  the agent calls this every state-sync tick and tolerates failures. */
export const syncTmuxSessions = mutation({
  args: {
    deviceId: v.string(),
    sessions: v.array(sessionArgs),
    // Present only when tmux enumeration completed successfully. Older agents
    // omit it; a timeout/error must never close rows by absence.
    fullSnapshot: v.optional(v.boolean()),
  },
  handler: async (ctx, { deviceId, sessions, fullSnapshot }) => {
    const userId = await resolveUser(ctx);
    // sessions: all open seats now, plus any that JUST closed (agent-side
    // change detection). Cap the array defensively — a pathological box with
    // hundreds of panes must not wedge the mutation.
    const capped = sessions.slice(0, 200);
    for (const s of capped) {
      await applySession(ctx, userId, deviceId, s);
    }

    if (fullSnapshot) {
      const openNames = new Set(
        capped.filter((session) => session.status === "open").map((session) => session.sessionName),
      );
      const existing = await ctx.db
        .query("tmuxRunnerSessions")
        .withIndex("by_device", (q: any) => q.eq("deviceId", deviceId))
        .collect();
      for (const row of existing) {
        if (row.userId !== userId) continue;
        // A successful exhaustive local scan is authoritative. Remove absent
        // open seats and clean legacy closed history in the same bounded pass.
        if (row.status === "closed" || !openNames.has(row.sessionName)) {
          await ctx.db.delete(row._id);
        }
      }
    }
    return { ok: true, applied: capped.length };
  },
});

/** Client-facing: the user's tmux runner-session ledger across every device.
 *  Joins device names + online state so a roster can render without a P2P
 *  connection. Identifiers + lifecycle only (see file header). */
export const list = query({
  args: {
    tokenHash: v.string(),
    deviceId: v.optional(v.string()),
    status: v.optional(tmuxSessionStatus),
  },
  handler: async (ctx, args) => {
    const userId = await userFromToken(ctx, args.tokenHash);
    let rows = args.status
      ? await ctx.db
        .query("tmuxRunnerSessions")
        .withIndex("by_user_status", (q: any) => q.eq("userId", userId).eq("status", args.status!))
        .take(500)
      : await ctx.db
        .query("tmuxRunnerSessions")
        .withIndex("by_user", (q: any) => q.eq("userId", userId))
        .take(500);
    if (args.deviceId) rows = rows.filter((r) => r.deviceId === args.deviceId);
    if (args.status) rows = rows.filter((r) => r.status === args.status);

    // Join device identity for display. Rows are few (one per tmux session),
    // so a small per-device lookup is fine; batch it by unique device id.
    const deviceIds = [...new Set(rows.map((r) => r.deviceId))];
    const meta = new Map<string, { name: string; online: boolean }>();
    for (const id of deviceIds) {
      const d = await ctx.db
        .query("devices")
        .withIndex("by_deviceId", (q: any) => q.eq("deviceId", id))
        .first();
      meta.set(id, { name: d?.name ?? "", online: d?.isOnline ?? false });
    }

    return rows
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .flatMap((r) => {
        // A split user-owned tmux session is several independently vibable
        // runner seats. Flatten pane records for existing clients while
        // preserving the session container identity on every row.
        const paneRows = r.panes?.length ? r.panes : [undefined];
        return paneRows.map((pane) => ({
          deviceId: r.deviceId,
          deviceName: meta.get(r.deviceId)?.name ?? "",
          deviceOnline: meta.get(r.deviceId)?.online ?? false,
          sessionName: r.sessionName,
          sessionId: r.sessionId ?? undefined,
          paneId: pane?.paneId ?? r.paneId ?? undefined,
          sessionKind: r.sessionKind ?? undefined,
          origin: r.origin ?? undefined,
          projectHint: r.projectHint ?? undefined,
          taskId: r.taskId ?? undefined,
          taskIdHint: r.taskIdHint ?? undefined,
          inputMode: pane?.inputMode ?? r.inputMode ?? undefined,
          runner: pane?.runner ?? r.runner,
          // Defend old inconsistent rows too: a session-level close always
          // wins over a stale pane-level "open" from an older mutation.
          status: r.status === "closed" ? "closed" : (pane?.status ?? r.status),
          paneCount: r.paneCount ?? undefined,
          startedAt: r.startedAt ?? undefined,
          firstSeenAt: r.firstSeenAt,
          lastSeenAt: r.lastSeenAt,
          closedAt: r.closedAt ?? undefined,
        }));
      })
      .filter((r) => !args.status || r.status === args.status);
  },
});
