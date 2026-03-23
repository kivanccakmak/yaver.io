import { v } from "convex/values";
import { mutation, query, internalQuery, QueryCtx, MutationCtx } from "./_generated/server";
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

/**
 * Fetch the first platform relay server and generate a unique per-user relay password.
 * Each user gets their own random password — the relay validates it via Convex backend.
 * Returns { relayUrl, relayPassword } or {} if no relay configured.
 */
async function getDefaultRelay(ctx: MutationCtx): Promise<{ relayUrl?: string; relayPassword?: string }> {
  const config = await ctx.db
    .query("platformConfig")
    .withIndex("by_key", (q) => q.eq("key", "relay_servers"))
    .unique();
  if (!config?.value) return {};
  try {
    const relays = JSON.parse(config.value);
    if (!Array.isArray(relays) || relays.length === 0) return {};
    const first = relays[0];
    return {
      relayUrl: first.httpUrl || undefined,
      relayPassword: randomHex(16), // unique per-user password, validated by relay via Convex
    };
  } catch {
    return {};
  }
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
    provider: "google" | "microsoft" | "apple" | "email";
    providerId: string;
    passwordHash?: string;
    avatarUrl?: string;
    surveyCompleted?: boolean;
    totpSecret?: string;
    totpEnabled?: boolean;
    totpRecoveryCodes?: string;
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
    provider: v.union(v.literal("google"), v.literal("microsoft"), v.literal("apple"), v.literal("email")),
    providerId: v.string(),
    avatarUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // First: exact provider+providerId match (returning user via same provider)
    const byProvider = await ctx.db
      .query("users")
      .withIndex("by_provider", (q) =>
        q.eq("provider", args.provider).eq("providerId", args.providerId)
      )
      .unique();

    if (byProvider) {
      const patch: Record<string, string | undefined> = {
        email: args.email,
        avatarUrl: args.avatarUrl,
      };
      // Only overwrite fullName if the new value is non-empty
      if (args.fullName) {
        patch.fullName = args.fullName;
      }
      await ctx.db.patch(byProvider._id, patch);
      // Ensure user has relay settings (may have been lost due to deletion/re-creation)
      const settings = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", byProvider._id))
        .first();
      if (!settings) {
        const defaultRelay = await getDefaultRelay(ctx);
        await ctx.db.insert("userSettings", { userId: byProvider._id, forceRelay: false, ...defaultRelay });
      } else if (!settings.relayPassword) {
        const defaultRelay = await getDefaultRelay(ctx);
        if (defaultRelay.relayPassword) {
          await ctx.db.patch(settings._id, defaultRelay);
        }
      }
      return byProvider._id;
    }

    // Second: email match (account linking — same user, different provider)
    const byEmail = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();

    if (byEmail) {
      // Link to existing account — update avatar/name if better data available
      const patch: Record<string, string | undefined> = {};
      if (args.avatarUrl) patch.avatarUrl = args.avatarUrl;
      if (args.fullName && (!byEmail.fullName || byEmail.fullName === byEmail.email)) {
        // Update name if current name is empty or just the email (placeholder)
        patch.fullName = args.fullName;
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(byEmail._id, patch);
      }
      // Ensure user has relay settings
      const settings = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", byEmail._id))
        .first();
      if (!settings) {
        const defaultRelay = await getDefaultRelay(ctx);
        await ctx.db.insert("userSettings", { userId: byEmail._id, forceRelay: false, ...defaultRelay });
      } else if (!settings.relayPassword) {
        const defaultRelay = await getDefaultRelay(ctx);
        if (defaultRelay.relayPassword) {
          await ctx.db.patch(settings._id, defaultRelay);
        }
      }
      return byEmail._id;
    }

    const userId = randomHex(16);
    const userDocId = await ctx.db.insert("users", {
      userId,
      email: args.email,
      fullName: args.fullName,
      provider: args.provider,
      providerId: args.providerId,
      avatarUrl: args.avatarUrl,
      createdAt: Date.now(),
    });
    // Create default settings for new user with platform relay as default
    const defaultRelay = await getDefaultRelay(ctx);
    await ctx.db.insert("userSettings", {
      userId: userDocId,
      forceRelay: false,
      ...defaultRelay,
    });
    return userDocId;
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
      surveyCompleted: result.user.surveyCompleted ?? false,
    };
  },
});

/**
 * Refresh a session — extends expiresAt by 30 days from now.
 * Returns the new expiresAt, or null if session is invalid/expired.
 */
export const refreshSession = mutation({
  args: {
    tokenHash: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();

    if (!session) return null;
    if (session.expiresAt < Date.now()) return null;

    const newExpiresAt = Date.now() + 365 * 24 * 60 * 60 * 1000; // 1 year
    await ctx.db.patch(session._id, { expiresAt: newExpiresAt });
    return { expiresAt: newExpiresAt };
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
 * Delete ALL sessions for a user (logout everywhere).
 * Validates the token first, then deletes every session for that user.
 */
export const deleteAllSessions = mutation({
  args: {
    tokenHash: v.string(),
  },
  handler: async (ctx, args) => {
    const result = await validateSessionInternal(ctx, args.tokenHash);
    if (!result) return;

    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_userId", (q) => q.eq("userId", result.user._id))
      .collect();
    for (const session of sessions) {
      await ctx.db.delete(session._id);
    }
  },
});

/**
 * Create a user with email/password.
 */
export const createEmailUser = mutation({
  args: {
    email: v.string(),
    fullName: v.string(),
    passwordHash: v.string(),
  },
  handler: async (ctx, args) => {
    // Check for duplicate email
    const existing = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();

    if (existing) {
      throw new Error("EMAIL_EXISTS");
    }

    const userId = randomHex(16);
    const userDocId = await ctx.db.insert("users", {
      userId,
      email: args.email,
      fullName: args.fullName,
      provider: "email",
      providerId: args.email,
      passwordHash: args.passwordHash,
      createdAt: Date.now(),
    });
    // Create default settings for new user with platform relay as default
    const defaultRelay = await getDefaultRelay(ctx);
    await ctx.db.insert("userSettings", {
      userId: userDocId,
      forceRelay: false,
      ...defaultRelay,
    });
    return userDocId;
  },
});

/**
 * Look up an email user for login. Returns user with passwordHash.
 */
export const lookupEmailUser = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();

    if (!user || user.provider !== "email") return null;

    return {
      _id: user._id,
      userId: user.userId,
      email: user.email,
      fullName: user.fullName,
      passwordHash: user.passwordHash,
    };
  },
});

/**
 * Check if a user has TOTP enabled. Used by login to decide if 2FA is required.
 */
export const getUserWithTotp = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return null;
    return { totpEnabled: user.totpEnabled ?? false };
  },
});

/**
 * Get the user document _id from a session token hash.
 * Used by device code authorization to pass a typed Id<"users"> to mutations.
 */
export const getUserDocId = query({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    const result = await validateSessionInternal(ctx, args.tokenHash);
    if (!result) return null;
    return result.user._id;
  },
});

/**
 * Update user profile fields (e.g. fullName).
 */
export const updateProfile = mutation({
  args: {
    tokenHash: v.string(),
    fullName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const result = await validateSessionInternal(ctx, args.tokenHash);
    if (!result) throw new Error("Unauthorized");

    const patch: Record<string, string> = {};
    if (args.fullName !== undefined) patch.fullName = args.fullName;

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(result.user._id, patch);
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

/** Look up a user by email (internal only — used by webhook handlers). */
export const getUserByEmail = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    return await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
  },
});