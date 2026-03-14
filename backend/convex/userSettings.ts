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
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("userSettings")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { forceRelay: args.forceRelay });
    } else {
      await ctx.db.insert("userSettings", {
        userId: args.userId,
        forceRelay: args.forceRelay,
      });
    }
  },
});
