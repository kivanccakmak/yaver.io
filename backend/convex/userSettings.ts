import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { validateSessionInternal, randomHex } from "./auth";

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
    keyStorage: v.optional(v.string()),
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
      keyStorage: args.keyStorage,
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
    keyStorage: v.optional(v.string()),
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
      keyStorage: args.keyStorage,
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

/** Admin: set settings by email (for manual user configuration). */
export const setByEmail = mutation({
  args: {
    email: v.string(),
    speechProvider: v.optional(v.string()),
    speechApiKey: v.optional(v.string()),
    ttsEnabled: v.optional(v.boolean()),
    verbosity: v.optional(v.number()),
    keyStorage: v.optional(v.string()),
    forceRelay: v.optional(v.boolean()),
    runnerId: v.optional(v.string()),
    customRunnerCommand: v.optional(v.string()),
    relayUrl: v.optional(v.string()),
    relayPassword: v.optional(v.string()),
    tunnelUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("email"), args.email))
      .first();
    if (!user) throw new Error(`User not found: ${args.email}`);
    const existing = await ctx.db
      .query("userSettings")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .first();
    const { email: _, ...fields } = args;
    if (existing) {
      await ctx.db.patch(existing._id, fields);
    } else {
      await ctx.db.insert("userSettings", { userId: user._id, ...fields });
    }
    return { ok: true, userId: user._id };
  },
});

/**
 * Seed default settings for all users who don't have settings yet.
 * Also generates per-user relay passwords and sets relayUrl for users missing them.
 * Run once: npx convex run userSettings:seedDefaults
 */
export const seedDefaults = mutation({
  args: {},
  handler: async (ctx) => {
    // Fetch default relay URL from platform config
    const config = await ctx.db
      .query("platformConfig")
      .withIndex("by_key", (q) => q.eq("key", "relay_servers"))
      .unique();
    let defaultRelayUrl: string | undefined;
    if (config?.value) {
      try {
        const relays = JSON.parse(config.value);
        if (Array.isArray(relays) && relays.length > 0) {
          defaultRelayUrl = relays[0].httpUrl;
        }
      } catch { /* ignore */ }
    }

    const allUsers = await ctx.db.query("users").collect();
    let seeded = 0;
    let updated = 0;
    for (const user of allUsers) {
      const existing = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", user._id))
        .first();
      if (!existing) {
        await ctx.db.insert("userSettings", {
          userId: user._id,
          forceRelay: false,
          relayUrl: defaultRelayUrl,
          relayPassword: randomHex(16),
        });
        seeded++;
      } else if (!existing.relayPassword) {
        // Backfill relay password for existing users without one
        const patch: Record<string, unknown> = { relayPassword: randomHex(16) };
        if (!existing.relayUrl && defaultRelayUrl) {
          patch.relayUrl = defaultRelayUrl;
        }
        await ctx.db.patch(existing._id, patch);
        updated++;
      }
    }
    return { seeded, updated, total: allUsers.length };
  },
});

/**
 * Validate a relay password — checks if any user has this relayPassword.
 * Called by relay servers via POST /relay/validate to authenticate per-user passwords.
 */
export const validateRelayPassword = query({
  args: { password: v.string() },
  handler: async (ctx, args) => {
    if (!args.password) return null;
    const allSettings = await ctx.db.query("userSettings").collect();
    const match = allSettings.find((s) => s.relayPassword === args.password);
    if (!match) return null;
    return { userId: match.userId };
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
