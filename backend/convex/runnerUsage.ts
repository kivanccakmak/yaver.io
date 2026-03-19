import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { validateSessionInternal } from "./auth";

/**
 * Record runner usage when a task finishes.
 * Called from the desktop agent with task duration info.
 */
export const record = mutation({
  args: {
    tokenHash: v.string(),
    deviceId: v.string(),
    taskId: v.string(),
    runner: v.string(),
    model: v.optional(v.string()),
    durationSec: v.number(),
    startedAt: v.number(),
    finishedAt: v.number(),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await validateSessionInternal(ctx, args.tokenHash);
    if (!session) return;

    await ctx.db.insert("runnerUsage", {
      userId: session.user.userId,
      deviceId: args.deviceId,
      taskId: args.taskId,
      runner: args.runner,
      model: args.model,
      durationSec: args.durationSec,
      startedAt: args.startedAt,
      finishedAt: args.finishedAt,
      source: args.source,
    });

    // Increment daily task count
    const date = new Date(args.startedAt).toISOString().slice(0, 10);
    const existing = await ctx.db
      .query("dailyTaskCounts")
      .withIndex("by_userId_date", (q) =>
        q.eq("userId", session.user.userId).eq("date", date)
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { taskCount: existing.taskCount + 1 });
    } else {
      await ctx.db.insert("dailyTaskCounts", {
        userId: session.user.userId,
        date,
        taskCount: 1,
      });
    }
  },
});

/**
 * Get usage summary for a user — daily/weekly/monthly totals.
 * Returns usage entries from the last 30 days.
 */
export const getUsage = query({
  args: {
    tokenHash: v.string(),
    since: v.optional(v.number()), // epoch ms, defaults to 30 days ago
  },
  handler: async (ctx, args) => {
    const session = await validateSessionInternal(ctx, args.tokenHash);
    if (!session) return { entries: [], daily: [], totalSeconds: 0 };

    const since = args.since ?? Date.now() - 30 * 24 * 60 * 60 * 1000;

    const entries = await ctx.db
      .query("runnerUsage")
      .withIndex("by_userId", (q) =>
        q.eq("userId", session.user.userId).gte("startedAt", since)
      )
      .collect();

    // Aggregate by day
    const dailyMap = new Map<string, { date: string; totalSec: number; taskCount: number; runners: Record<string, number> }>();
    let totalSeconds = 0;

    for (const e of entries) {
      const date = new Date(e.startedAt).toISOString().slice(0, 10); // YYYY-MM-DD
      const existing = dailyMap.get(date) || { date, totalSec: 0, taskCount: 0, runners: {} };
      existing.totalSec += e.durationSec;
      existing.taskCount += 1;
      existing.runners[e.runner] = (existing.runners[e.runner] || 0) + e.durationSec;
      dailyMap.set(date, existing);
      totalSeconds += e.durationSec;
    }

    const daily = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    return { entries, daily, totalSeconds };
  },
});

/**
 * Get daily task counts for analytics charts.
 * Returns last N days of task counts.
 */
export const getDailyTaskCounts = query({
  args: {
    tokenHash: v.string(),
    days: v.optional(v.number()), // defaults to 30
  },
  handler: async (ctx, args) => {
    const session = await validateSessionInternal(ctx, args.tokenHash);
    if (!session) return { counts: [] };

    const days = args.days ?? 30;
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceDate = since.toISOString().slice(0, 10);

    const counts = await ctx.db
      .query("dailyTaskCounts")
      .withIndex("by_userId_date", (q) =>
        q.eq("userId", session.user.userId).gte("date", sinceDate)
      )
      .collect();

    return { counts };
  },
});
