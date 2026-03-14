import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const writeLog = mutation({
  args: {
    userId: v.optional(v.string()),
    platform: v.string(),
    appVersion: v.string(),
    buildNumber: v.string(),
    level: v.union(v.literal("info"), v.literal("error"), v.literal("warn")),
    step: v.string(),
    message: v.string(),
    details: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("mobileStreamLogs", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("mobileStreamLogs")
      .withIndex("by_createdAt")
      .order("desc")
      .take(args.limit ?? 100);
  },
});
