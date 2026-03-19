import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { validateSessionInternal } from "./auth";

export const get = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("userSettings")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
  },
});

/** Get settings by auth token (used from HTTP endpoints). */
export const getByToken = query({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    const session = await validateSessionInternal(ctx, args.tokenHash);
    if (!session) return null;
    return await ctx.db
      .query("userSettings")
      .withIndex("by_userId", (q) => q.eq("userId", session.user._id))
      .first();
  },
});

export const set = mutation({
  args: {
    userId: v.id("users"),
    forceRelay: v.optional(v.boolean()),
    runnerId: v.optional(v.string()),
    customRunnerCommand: v.optional(v.string()),
    relayUrl: v.optional(v.string()),
    relayPassword: v.optional(v.string()),
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
      relayUrl: args.relayUrl,
      relayPassword: args.relayPassword,
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

/** Set settings by auth token (used from HTTP endpoints). */
export const setByToken = mutation({
  args: {
    tokenHash: v.string(),
    forceRelay: v.optional(v.boolean()),
    runnerId: v.optional(v.string()),
    customRunnerCommand: v.optional(v.string()),
    relayUrl: v.optional(v.string()),
    relayPassword: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await validateSessionInternal(ctx, args.tokenHash);
    if (!session) throw new Error("Unauthorized");
    const userId = session.user._id;
    const existing = await ctx.db
      .query("userSettings")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .first();
    const patch = {
      forceRelay: args.forceRelay,
      runnerId: args.runnerId,
      customRunnerCommand: args.customRunnerCommand,
      relayUrl: args.relayUrl,
      relayPassword: args.relayPassword,
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("userSettings", {
        userId,
        ...patch,
      });
    }
  },
});

/**
 * Seed default settings (forceRelay: true) for all users who don't have settings yet.
 * Run once: npx convex run userSettings:seedDefaults
 */
export const seedDefaults = mutation({
  args: {},
  handler: async (ctx) => {
    const allUsers = await ctx.db.query("users").collect();
    let seeded = 0;
    for (const user of allUsers) {
      const existing = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", user._id))
        .first();
      if (!existing) {
        await ctx.db.insert("userSettings", {
          userId: user._id,
          forceRelay: true,
        });
        seeded++;
      }
    }
    return { seeded, total: allUsers.length };
  },
});
