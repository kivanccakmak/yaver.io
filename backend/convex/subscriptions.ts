import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { validateSessionInternal } from "./auth";

// ── Queries ──────────────────────────────────────────────────────────

/**
 * Get the subscription status for a user by session token hash.
 * Returns the active subscription and plan info.
 */
export const getSubscriptionStatus = query({
  args: {
    tokenHash: v.string(),
  },
  handler: async (ctx, args) => {
    const result = await validateSessionInternal(ctx, args.tokenHash);
    if (!result) return null;

    const subscription = await ctx.db
      .query("subscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", result.user.userId))
      .order("desc")
      .first();

    return {
      plan: result.user.plan ?? "early_access",
      subscription: subscription
        ? {
            status: subscription.status,
            plan: subscription.plan,
            platform: subscription.platform,
            currentPeriodEnd: subscription.currentPeriodEnd,
            cancelledAt: subscription.cancelledAt,
            lemonSqueezySubscriptionId: subscription.lemonSqueezySubscriptionId,
          }
        : null,
    };
  },
});

/**
 * Simple query to get user's current plan.
 */
export const getUserPlan = query({
  args: {
    tokenHash: v.string(),
  },
  handler: async (ctx, args) => {
    const result = await validateSessionInternal(ctx, args.tokenHash);
    if (!result) return null;

    return {
      plan: result.user.plan ?? "early_access",
    };
  },
});

// ── Mutations ────────────────────────────────────────────────────────

/**
 * Upsert a subscription from LemonSqueezy webhook data.
 * Matches by lemonSqueezySubscriptionId if available, otherwise creates new.
 */
export const upsertSubscription = mutation({
  args: {
    userId: v.string(),
    platform: v.union(v.literal("web"), v.literal("ios"), v.literal("android")),
    plan: v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise")),
    status: v.union(
      v.literal("active"),
      v.literal("cancelled"),
      v.literal("expired"),
      v.literal("past_due"),
      v.literal("early_access"),
    ),
    lemonSqueezySubscriptionId: v.optional(v.string()),
    lemonSqueezyCustomerId: v.optional(v.string()),
    lemonSqueezyOrderId: v.optional(v.string()),
    variantId: v.optional(v.string()),
    productId: v.optional(v.string()),
    currentPeriodEnd: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Try to find existing subscription by lemonSqueezySubscriptionId
    let existing = null;
    if (args.lemonSqueezySubscriptionId) {
      existing = await ctx.db
        .query("subscriptions")
        .withIndex("by_lemonSqueezySubscriptionId", (q) =>
          q.eq("lemonSqueezySubscriptionId", args.lemonSqueezySubscriptionId)
        )
        .unique();
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        status: args.status,
        plan: args.plan,
        lemonSqueezyCustomerId: args.lemonSqueezyCustomerId,
        lemonSqueezyOrderId: args.lemonSqueezyOrderId,
        variantId: args.variantId,
        productId: args.productId,
        currentPeriodEnd: args.currentPeriodEnd,
        cancelledAt: args.cancelledAt,
        updatedAt: now,
      });

      // Also update user's plan field
      const user = await ctx.db
        .query("users")
        .filter((q) => q.eq(q.field("userId"), args.userId))
        .unique();
      if (user) {
        const userPlan = args.status === "active" ? args.plan : "free";
        await ctx.db.patch(user._id, { plan: userPlan });
      }

      return existing._id;
    }

    // Create new subscription
    const subscriptionId = await ctx.db.insert("subscriptions", {
      userId: args.userId,
      platform: args.platform,
      plan: args.plan,
      status: args.status,
      lemonSqueezySubscriptionId: args.lemonSqueezySubscriptionId,
      lemonSqueezyCustomerId: args.lemonSqueezyCustomerId,
      lemonSqueezyOrderId: args.lemonSqueezyOrderId,
      variantId: args.variantId,
      productId: args.productId,
      currentPeriodEnd: args.currentPeriodEnd,
      cancelledAt: args.cancelledAt,
      createdAt: now,
      updatedAt: now,
    });

    // Update user's plan field
    const user = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("userId"), args.userId))
      .unique();
    if (user) {
      const userPlan = args.status === "active" ? args.plan : "free";
      await ctx.db.patch(user._id, { plan: userPlan });
    }

    return subscriptionId;
  },
});

/**
 * Create an early_access subscription for a new user.
 */
export const createEarlyAccessSubscription = mutation({
  args: {
    userId: v.string(),
    platform: v.union(v.literal("web"), v.literal("ios"), v.literal("android")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Check if user already has a subscription
    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();

    if (existing) {
      return existing._id;
    }

    return await ctx.db.insert("subscriptions", {
      userId: args.userId,
      platform: args.platform,
      plan: "pro",
      status: "early_access",
      createdAt: now,
      updatedAt: now,
    });
  },
});
