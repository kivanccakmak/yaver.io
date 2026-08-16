import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { validateSessionInternal } from "./auth";

const runtime = v.union(v.literal("remote-agent"), v.literal("local-yaver"), v.literal("cloud-runner"), v.literal("queued"));
const status = v.union(v.literal("queued"), v.literal("running"), v.literal("completed"), v.literal("failed"), v.literal("stopped"));

export const record = mutation({
  args: { tokenHash: v.string(), taskId: v.string(), runtime, status, runnerId: v.optional(v.string()), model: v.optional(v.string()), reasoningEffort: v.optional(v.string()), deviceId: v.optional(v.string()), gitProvider: v.optional(v.union(v.literal("github"), v.literal("gitlab"))), gitRef: v.optional(v.string()), commitSha: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const session = await validateSessionInternal(ctx, args.tokenHash);
    if (!session) throw new Error("Unauthorized");
    const existing = await ctx.db.query("taskRuns").withIndex("by_user_task", q => q.eq("userId", session.user.userId).eq("taskId", args.taskId)).first();
    const { tokenHash: _tokenHash, ...metadata } = args;
    const value = { ...metadata, userId: session.user.userId, updatedAt: Date.now() };
    if (existing) await ctx.db.patch(existing._id, value);
    else await ctx.db.insert("taskRuns", { ...value, createdAt: Date.now() });
  },
});

export const list = query({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    const session = await validateSessionInternal(ctx, args.tokenHash);
    if (!session) return [];
    return await ctx.db.query("taskRuns").withIndex("by_user_updated", q => q.eq("userId", session.user.userId)).order("desc").take(100);
  },
});
