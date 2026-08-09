// tmuxSessions.ts — durable tmux runner-session ledger.
//
// The Go agent (desktop/agent/tmux_convex.go) pushes a privacy-safe snapshot of
// every tmux session on each owned device here on its state-sync tick: session
// name, tmux session/pane ids, the runner living in it (claude/codex/opencode
// or shell/unknown), and whether that seat is open or closed. Every surface —
// mobile Tasks, web dashboard, TV/watch — can then answer "which machines have
// which runner seats, open or closed?" straight from Convex, without connecting
// P2P to the box, and keep vibing into a session that survived an agent
// restart (adoption state is in-memory on the agent and dies with it).
//
// PRIVACY: identifiers and lifecycle only. No pane content, no current-path
// (absolute paths leak the home-dir username), no prompts, no titles, no
// models. convex_privacy_test.go fences the agent payload; this module's args
// validator is the second gate.
//
// Auth model:
//   - syncTmuxSessions is called by the agent over its existing bearer-token
//     /api/mutation path, so it authenticates via getUserIdentity exactly like
//     every agentSync:* mutation.
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

const sessionArgs = v.object({
  sessionName: v.string(),
  sessionId: v.optional(v.string()),
  paneId: v.optional(v.string()),
  runner: tmuxRunner,
  status: tmuxSessionStatus,
  paneCount: v.optional(v.number()),
  firstSeenAt: v.optional(v.number()),
  closedAt: v.optional(v.number()),
});

async function userFromToken(ctx: any, tokenHash: string): Promise<Id<"users">> {
  const session = await validateSessionInternal(ctx, tokenHash);
  if (!session) throw new Error("Unauthorized");
  return session.user._id;
}

/** Apply one session row to the ledger. Sticky firstSeenAt, one-way close. */
async function applySession(
  ctx: any,
  userId: Id<"users">,
  deviceId: string,
  s: {
    sessionName: string;
    sessionId?: string;
    paneId?: string;
    runner: string;
    status: "open" | "closed";
    paneCount?: number;
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
      // Keep the row's own firstSeenAt; the agent's closed record may carry a
      // firstSeenAt from its persisted cache that is OLDER than the row.
      await ctx.db.patch(existing._id, {
        sessionId: s.sessionId ?? existing.sessionId,
        paneId: s.paneId ?? existing.paneId,
        runner: s.runner === "unknown" ? existing.runner : s.runner,
        status: "closed",
        closedAt: s.closedAt ?? now,
        lastSeenAt: now,
      });
    } else {
      // A seat we never saw open (agent restarted between open and close, or
      // the agent's own cache predates the ledger). Record the closure anyway
      // so the roster shows the session existed and is now closed.
      await ctx.db.insert("tmuxRunnerSessions", {
        userId,
        deviceId,
        sessionName: s.sessionName,
        sessionId: s.sessionId,
        paneId: s.paneId,
        runner: s.runner === "unknown" ? "unknown" : s.runner,
        status: "closed",
        paneCount: s.paneCount,
        firstSeenAt: s.firstSeenAt ?? now,
        lastSeenAt: now,
        closedAt: s.closedAt ?? now,
      });
    }
    return;
  }

  // open
  if (existing) {
    await ctx.db.patch(existing._id, {
      sessionId: s.sessionId,
      paneId: s.paneId,
      runner: s.runner === "unknown" ? existing.runner : s.runner,
      status: "open",
      paneCount: s.paneCount ?? existing.paneCount,
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
      runner: s.runner === "unknown" ? "unknown" : s.runner,
      status: "open",
      paneCount: s.paneCount,
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
  },
  handler: async (ctx, { deviceId, sessions }) => {
    const userId = await resolveUser(ctx);
    // sessions: all open seats now, plus any that JUST closed (agent-side
    // change detection). Cap the array defensively — a pathological box with
    // hundreds of panes must not wedge the mutation.
    const capped = sessions.slice(0, 200);
    for (const s of capped) {
      await applySession(ctx, userId, deviceId, s);
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
    let rows = await ctx.db
      .query("tmuxRunnerSessions")
      .withIndex("by_user", (q: any) => q.eq("userId", userId))
      .collect();
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
      .map((r) => ({
        deviceId: r.deviceId,
        deviceName: meta.get(r.deviceId)?.name ?? "",
        deviceOnline: meta.get(r.deviceId)?.online ?? false,
        sessionName: r.sessionName,
        sessionId: r.sessionId ?? undefined,
        paneId: r.paneId ?? undefined,
        runner: r.runner,
        status: r.status,
        paneCount: r.paneCount ?? undefined,
        firstSeenAt: r.firstSeenAt,
        lastSeenAt: r.lastSeenAt,
        closedAt: r.closedAt ?? undefined,
      }));
  },
});
