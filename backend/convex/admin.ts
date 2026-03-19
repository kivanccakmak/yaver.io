import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * Admin utilities for user data cleanup.
 * These are not exposed via HTTP — only callable via Convex client (scripts/dashboard).
 */

/** List all users. */
export const listAllUsers = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("users").collect();
  },
});

/** List all sessions. */
export const listAllSessions = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("sessions").collect();
  },
});

/** List all devices. */
export const listAllDevices = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("devices").collect();
  },
});

/** Find all users by email. Returns array of user documents. */
export const getUsersByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .collect();
  },
});

/** Delete ALL user data from the system — users, sessions, devices, and all per-user metadata. */
export const deleteAllUserData = mutation({
  args: {},
  handler: async (ctx) => {
    const tables = [
      "users",
      "sessions",
      "devices",
      "userSettings",
      "developerSurveys",
      "runnerUsage",
      "dailyTaskCounts",
      "deviceMetrics",
      "deviceEvents",
    ] as const;

    const counts: Record<string, number> = {};
    for (const table of tables) {
      const docs = await ctx.db.query(table).collect();
      for (const doc of docs) {
        await ctx.db.delete(doc._id);
      }
      counts[table] = docs.length;
    }

    return counts;
  },
});

/** Delete a user and all their sessions and devices by user _id. */
export const deleteUserData = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("User not found");

    // Delete all sessions
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    for (const session of sessions) {
      await ctx.db.delete(session._id);
    }

    // Delete all devices
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
    for (const device of devices) {
      await ctx.db.delete(device._id);
    }

    // Delete the user
    await ctx.db.delete(args.userId);

    return {
      email: user.email,
      sessionsDeleted: sessions.length,
      devicesDeleted: devices.length,
    };
  },
});
