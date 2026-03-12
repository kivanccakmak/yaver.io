import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const writeLog = mutation({
  args: {
    level: v.union(v.literal("info"), v.literal("error"), v.literal("warn")),
    provider: v.string(),
    step: v.string(),
    message: v.string(),
    details: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("authLogs", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const recentLogs = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    return await ctx.db
      .query("authLogs")
      .withIndex("by_createdAt")
      .order("desc")
      .take(limit);
  },
});
