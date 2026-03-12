import { v } from "convex/values";
import { mutation, query, QueryCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";

// ── Helpers ──────────────────────────────────────────────────────────

/** SHA-256 hex digest of a string. Works in Convex runtime (Web Crypto). */
export async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Generate a random hex string of `bytes` length (default 32 = 256 bits). */
export function randomHex(bytes: number = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Validate a session token hash and return the associated user, or null. */
export async function validateSessionInternal(
  ctx: QueryCtx,
  tokenHash: string
): Promise<{
  user: {
    _id: Id<"users">;
    userId: string;
    email: string;
    fullName: string;
    provider: "google" | "microsoft" | "apple";
    providerId: string;
    avatarUrl?: string;
    plan?: "free" | "pro" | "enterprise" | "early_access";
    createdAt: number;
  };
  sessionId: Id<"sessions">;
} | null> {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .unique();

  if (!session) return null;
  if (session.expiresAt < Date.now()) return null;

  const user = await ctx.db.get(session.userId);
  if (!user) return null;

  return { user, sessionId: session._id };
}

// ── Mutations ────────────────────────────────────────────────────────

/**
 * Upsert a user by provider + providerId.
 * Returns the user's _id.
 */
export const createOrUpdateUser = mutation({
  args: {
    email: v.string(),
    fullName: v.string(),
    provider: v.union(v.literal("google"), v.literal("microsoft"), v.literal("apple")),
    providerId: v.string(),
    avatarUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_provider", (q) =>
        q.eq("provider", args.provider).eq("providerId", args.providerId)
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        email: args.email,
        fullName: args.fullName,
        avatarUrl: args.avatarUrl,
      });
      return existing._id;
    }

    const userId = randomHex(16);
    return await ctx.db.insert("users", {
      userId,
      email: args.email,
      fullName: args.fullName,
      provider: args.provider,
      providerId: args.providerId,
      avatarUrl: args.avatarUrl,
      plan: "early_access",
      createdAt: Date.now(),
    });
  },
});

/**
 * Create a session for a user. Accepts a pre-hashed token (sha256).
 * Returns the session _id.
 */
export const createSession = mutation({
  args: {
    tokenHash: v.string(),
    userId: v.id("users"),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("sessions", {
      tokenHash: args.tokenHash,
      userId: args.userId,
      expiresAt: args.expiresAt,
      createdAt: Date.now(),
    });
  },
});

/**
 * Validate a session by tokenHash. Returns the user if valid, null otherwise.
 */
export const validateSession = query({
  args: {
    tokenHash: v.string(),
  },
  handler: async (ctx, args) => {
    const result = await validateSessionInternal(ctx, args.tokenHash);
    if (!result) return null;
    return {
      userId: result.user.userId,
      email: result.user.email,
      fullName: result.user.fullName,
      provider: result.user.provider,
      avatarUrl: result.user.avatarUrl,
    };
  },
});

/**
 * Delete a session (logout).
 */
export const deleteSession = mutation({
  args: {
    tokenHash: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();

    if (session) {
      await ctx.db.delete(session._id);
    }
  },
});

/**
 * Delete a user account and all associated data (sessions, devices).
 * Requires a valid session token.
 */
export const deleteAccount = mutation({
  args: {
    tokenHash: v.string(),
  },
  handler: async (ctx, args) => {
    const result = await validateSessionInternal(ctx, args.tokenHash);
    if (!result) {
      throw new Error("Unauthorized");
    }

    const userId = result.user._id;

    // Delete all sessions for this user
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    for (const session of sessions) {
      await ctx.db.delete(session._id);
    }

    // Delete all devices for this user
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    for (const device of devices) {
      await ctx.db.delete(device._id);
    }

    // Delete the user
    await ctx.db.delete(userId);
  },
});
