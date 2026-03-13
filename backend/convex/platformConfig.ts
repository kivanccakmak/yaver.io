import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

/**
 * Platform-level configuration managed by Yaver (not by customers).
 * Stores relay server list and other infrastructure config.
 *
 * Key configs:
 *   "relay_servers" — JSON array of relay servers:
 *     [
 *       {"id":"hel1","quicAddr":"37.27.184.85:4433","httpUrl":"http://37.27.184.85:8443","region":"eu-hel","priority":1},
 *       {"id":"fsn1","quicAddr":"xx.xx.xx.xx:4433","httpUrl":"http://xx.xx.xx.xx:8443","region":"eu-fsn","priority":2}
 *     ]
 *   Clients connect to all available relays for redundancy.
 *   If one goes down, traffic automatically routes through others.
 */

/** Get a config value by key. */
export const get = query({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const config = await ctx.db
      .query("platformConfig")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    return config?.value ?? null;
  },
});

/** Get all config values needed by clients (relay servers, etc.). */
export const getClientConfig = query({
  args: {},
  handler: async (ctx) => {
    const configs = await ctx.db.query("platformConfig").collect();
    const result: Record<string, string> = {};
    for (const c of configs) {
      result[c.key] = c.value;
    }
    return result;
  },
});

/** Set a config value (admin only — called from Convex dashboard or scripts). */
export const set = mutation({
  args: {
    key: v.string(),
    value: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("platformConfig")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        value: args.value,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("platformConfig", {
        key: args.key,
        value: args.value,
        updatedAt: Date.now(),
      });
    }
  },
});
