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
    tunnelUrl: v.optional(v.string()),
    speechProvider: v.optional(v.string()),
    speechApiKey: v.optional(v.string()),
    ttsEnabled: v.optional(v.boolean()),
    verbosity: v.optional(v.number()),
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
      tunnelUrl: args.tunnelUrl,
      speechProvider: args.speechProvider,
      speechApiKey: args.speechApiKey,
      ttsEnabled: args.ttsEnabled,
      verbosity: args.verbosity,
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
    tunnelUrl: v.optional(v.string()),
    speechProvider: v.optional(v.string()),
    speechApiKey: v.optional(v.string()),
    ttsEnabled: v.optional(v.boolean()),
    verbosity: v.optional(v.number()),
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
      tunnelUrl: args.tunnelUrl,
      speechProvider: args.speechProvider,
      speechApiKey: args.speechApiKey,
      ttsEnabled: args.ttsEnabled,
      verbosity: args.verbosity,
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
 * Seed default settings (forceRelay: false) for all users who don't have settings yet.
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
          forceRelay: false,
        });
        seeded++;
      }
    }
    return { seeded, total: allUsers.length };
  },
});

/**
 * Migrate all existing users to forceRelay: false.
 * Run once: npx convex run userSettings:migrateForceRelayOff
 */
export const migrateForceRelayOff = mutation({
  args: {},
  handler: async (ctx) => {
    const allSettings = await ctx.db.query("userSettings").collect();
    let updated = 0;
    for (const settings of allSettings) {
      if (settings.forceRelay === true || settings.forceRelay === undefined) {
        await ctx.db.patch(settings._id, { forceRelay: false });
        updated++;
      }
    }
    return { updated, total: allSettings.length };
  },
});
