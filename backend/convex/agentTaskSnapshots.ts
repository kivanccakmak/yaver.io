// Minimal per-device task lifecycle snapshots.
//
// The owning Go agent is authoritative. Convex stores only opaque identities,
// lifecycle, and observation time so clients can invalidate stale local UI.
// Titles, prompts, output, paths, project names, models, and source never enter
// this table.

import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { validateSessionInternal } from "./auth";
import { resolveUser } from "./agentSync";

const lifecycleStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("ready"),
  v.literal("review"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("stopped"),
);

const lifecycleTask = v.object({
  taskId: v.string(),
  yaverSessionId: v.optional(v.string()),
  status: lifecycleStatus,
  hostKind: v.optional(v.union(
    v.literal("terminal_tmux"),
    v.literal("desktop_gui"),
    v.literal("runner_process"),
  )),
  updatedAt: v.number(),
});

async function userFromToken(ctx: any, tokenHash: string): Promise<Id<"users">> {
  const session = await validateSessionInternal(ctx, tokenHash);
  if (!session) throw new Error("Unauthorized");
  return session.user._id;
}

type LifecycleTask = {
  taskId: string;
  yaverSessionId?: string;
  status: "queued" | "running" | "ready" | "review" | "completed" | "failed" | "stopped";
  hostKind?: "terminal_tmux" | "desktop_gui" | "runner_process";
  updatedAt: number;
};

async function upsertSnapshot(
  ctx: any,
  userId: Id<"users">,
  args: { deviceId: string; observedAt: number; tasks: LifecycleTask[] },
) {
  // Authenticate ownership against the device registry before looking at the
  // snapshot row. A missing row must never turn an arbitrary deviceId into an
  // insert owned by the caller.
  const device = await ctx.db
    .query("devices")
    .withIndex("by_deviceId", (q: any) => q.eq("deviceId", args.deviceId))
    .first();
  if (!device || device.userId !== userId) {
    throw new Error("Device ownership mismatch");
  }

  const tasks = args.tasks.slice(0, 200);
  const existing = await ctx.db
    .query("agentTaskSnapshots")
    .withIndex("by_device", (q: any) => q.eq("deviceId", args.deviceId))
    .first();
  if (existing && existing.userId !== userId) {
    throw new Error("Device ownership mismatch");
  }
  const value = {
    userId,
    deviceId: args.deviceId,
    // Server time prevents a machine with a skewed clock from making its
    // observation appear newer than subsequent snapshots.
    observedAt: Date.now(),
    tasks,
  };
  if (existing) await ctx.db.patch(existing._id, value);
  else await ctx.db.insert("agentTaskSnapshots", value);

  // One-time migration cleanup. Task snapshots supersede the old tmux
  // inventory, whose session names could include project hints and whose
  // separate heartbeat doubled quiet-machine writes. Never delete a row
  // belonging to another account even if a device id is ever reused.
  const legacyRows = await ctx.db
    .query("tmuxRunnerSessions")
    .withIndex("by_device", (q: any) => q.eq("deviceId", args.deviceId))
    .take(201);
  for (const row of legacyRows) {
    if (row.userId === userId) await ctx.db.delete(row._id);
  }
  return { ok: true, applied: tasks.length };
}

/** Convex-native compatibility path. Yaver bearer sessions do not authenticate
 * this endpoint; current Go agents publish through POST /task-snapshots. */
export const sync = mutation({
  args: {
    deviceId: v.string(),
    observedAt: v.number(),
    tasks: v.array(lifecycleTask),
  },
  handler: async (ctx, args) => {
    const userId = await resolveUser(ctx);
    return upsertSnapshot(ctx, userId, args);
  },
});

/** HTTP-action bridge for the agent's opaque Yaver bearer session. */
export const syncByToken = internalMutation({
  args: {
    tokenHash: v.string(),
    deviceId: v.string(),
    observedAt: v.number(),
    tasks: v.array(lifecycleTask),
  },
  handler: async (ctx, args) => {
    const userId = await userFromToken(ctx, args.tokenHash);
    return upsertSnapshot(ctx, userId, args);
  },
});

export const list = query({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    const userId = await userFromToken(ctx, args.tokenHash);
    const snapshots = await ctx.db
      .query("agentTaskSnapshots")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(100);
    const devices = new Map<string, { name: string; online: boolean; lastHeartbeat: number }>();
    for (const deviceId of new Set(snapshots.map((snapshot) => snapshot.deviceId))) {
      const device = await ctx.db
        .query("devices")
        .withIndex("by_deviceId", (q) => q.eq("deviceId", deviceId))
        .first();
      devices.set(deviceId, {
        name: device?.name ?? "",
        online: device?.isOnline ?? false,
        lastHeartbeat: device?.lastHeartbeat ?? 0,
      });
    }
    return snapshots.map((snapshot) => ({
      deviceId: snapshot.deviceId,
      deviceName: devices.get(snapshot.deviceId)?.name ?? "",
      deviceOnline: devices.get(snapshot.deviceId)?.online ?? false,
      deviceLastHeartbeat: devices.get(snapshot.deviceId)?.lastHeartbeat ?? 0,
      observedAt: snapshot.observedAt,
      tasks: snapshot.tasks,
    }));
  },
});
