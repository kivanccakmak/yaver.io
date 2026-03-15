import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Only these emails can write/read developer logs
const DEVELOPER_EMAILS = [
  "kivanc.cakmak@icloud.com",
  "kivanccakmak@gmail.com",
];

function isDeveloper(email?: string): boolean {
  return !!email && DEVELOPER_EMAILS.includes(email.toLowerCase());
}

/** Write a developer log entry. Only accepted from developer emails. */
export const writeLog = mutation({
  args: {
    email: v.optional(v.string()),
    userId: v.optional(v.string()),
    source: v.union(v.literal("agent"), v.literal("mobile"), v.literal("web"), v.literal("relay")),
    level: v.union(v.literal("info"), v.literal("error"), v.literal("warn"), v.literal("debug")),
    tag: v.string(),
    message: v.string(),
    data: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!isDeveloper(args.email)) return null;
    return await ctx.db.insert("developerLogs", {
      userId: args.userId,
      email: args.email,
      source: args.source,
      level: args.level,
      tag: args.tag,
      message: args.message,
      data: args.data ? args.data.slice(0, 8000) : undefined,
      createdAt: Date.now(),
    });
  },
});

/** Get recent developer logs. */
export const getLogs = query({
  args: {
    limit: v.optional(v.number()),
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    if (args.email) {
      return await ctx.db
        .query("developerLogs")
        .withIndex("by_email", (q) => q.eq("email", args.email!))
        .order("desc")
        .take(limit);
    }
    return await ctx.db
      .query("developerLogs")
      .order("desc")
      .take(limit);
  },
});

/** Clear all developer logs. */
export const clearLogs = mutation({
  args: {},
  handler: async (ctx) => {
    const logs = await ctx.db.query("developerLogs").collect();
    for (const log of logs) {
      await ctx.db.delete(log._id);
    }
    return logs.length;
  },
});
