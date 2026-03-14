import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const get = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("userSettings")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
  },
});

export const set = mutation({
  args: {
    userId: v.id("users"),
    forceRelay: v.optional(v.boolean()),
    runnerId: v.optional(v.string()),
    customRunnerCommand: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("userSettings")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
    const patch = {
      forceRelay: args.forceRelay,
      runnerId: args.runnerId,
      customRunnerCommand: args.customRunnerCommand,
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("userSettings", {
        userId: args.userId,
        ...patch,
      });
    }
  },
});
