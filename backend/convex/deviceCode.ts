import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { randomHex, sha256Hex, validateSessionInternal } from "./auth";

const DEVICE_CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes

/** Generate a human-readable user code like "ABCD-1234". */
function generateUserCode(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I, O (ambiguous)
  const digits = "0123456789";
  let code = "";
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 4; i++) {
    code += letters[buf[i] % letters.length];
  }
  code += "-";
  for (let i = 4; i < 8; i++) {
    code += digits[buf[i] % digits.length];
  }
  return code;
}

/**
 * Create a new device code for headless CLI auth.
 * Returns userCode (shown to user) and deviceCode (used by CLI to poll).
 */
export const createDeviceCode = mutation({
  args: {
    machineName: v.optional(v.string()),
    platform: v.optional(v.string()),
    arch: v.optional(v.string()),
    shell: v.optional(v.string()),
    environment: v.optional(v.string()),
    runtimeVersion: v.optional(v.string()),
    preferredProvider: v.optional(v.string()),
    isWsl: v.optional(v.boolean()),
    deviceId: v.optional(v.string()),
    /** Owner hint for the proactive phone-approval event. Free-form string
     *  from the (unauthenticated) device; validated against a real users
     *  row and silently dropped otherwise. Grants nothing — see schema. */
    ownerUserIdHint: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Clean up expired codes lazily (delete up to 10). Uses the by_expiresAt
    // INDEX, not a .filter() table scan: the old scan made this O(table), so
    // an attacker flooding live rows turned every insert into a cost bomb.
    const expired = await ctx.db
      .query("deviceCodes")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", Date.now()))
      .take(10);
    for (const code of expired) {
      await ctx.db.delete(code._id);
    }

    // Generate unique userCode (retry on collision with pending codes)
    let userCode: string;
    let attempts = 0;
    do {
      userCode = generateUserCode();
      const existing = await ctx.db
        .query("deviceCodes")
        .withIndex("by_userCode", (q) => q.eq("userCode", userCode))
        .unique();
      if (!existing || existing.status !== "pending") break;
      attempts++;
    } while (attempts < 5);

    const deviceCode = randomHex(20); // 40-char hex
    const now = Date.now();

    // Validate the owner hint against a real users row; anything else is
    // silently dropped (an unauthenticated caller must not learn whether an
    // id exists, and a bogus hint must not create dangling references).
    let ownerHintUserId: Id<"users"> | undefined;
    if (args.ownerUserIdHint) {
      const normalized = ctx.db.normalizeId("users", args.ownerUserIdHint.trim());
      if (normalized && (await ctx.db.get(normalized))) {
        ownerHintUserId = normalized;
      }
    }

    await ctx.db.insert("deviceCodes", {
      userCode,
      deviceCode,
      status: "pending",
      ownerHintUserId,
      machineName: args.machineName,
      platform: args.platform,
      arch: args.arch,
      shell: args.shell,
      environment: args.environment,
      runtimeVersion: args.runtimeVersion,
      preferredProvider: args.preferredProvider,
      isWsl: args.isWsl,
      deviceId: args.deviceId,
      expiresAt: now + DEVICE_CODE_TTL_MS,
      createdAt: now,
    });

    return {
      userCode,
      deviceCode,
      expiresAt: now + DEVICE_CODE_TTL_MS,
    };
  },
});

/**
 * Pending codes whose owner HINT names the given user — the feed behind the
 * proactive phone-approval event. INTERNAL on purpose: the HTTP route derives
 * `userId` from the caller's bearer session (never a client arg), because a
 * pending userCode is approval-capable — leaking another user's pending code
 * would let an attacker approve that device into the ATTACKER's account.
 */
export const pendingApprovalsForUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("deviceCodes")
      .withIndex("by_ownerHint", (q) => q.eq("ownerHintUserId", args.userId).eq("status", "pending"))
      .take(10);
    return rows
      .filter((row) => row.expiresAt > now)
      .map((row) => ({
        userCode: row.userCode,
        machineName: row.machineName ?? null,
        platform: row.platform ?? null,
        environment: row.environment ?? null,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      }));
  },
});

export const getDeviceCodeInfo = query({
  args: { userCode: v.string() },
  handler: async (ctx, args) => {
    const code = await ctx.db
      .query("deviceCodes")
      .withIndex("by_userCode", (q) => q.eq("userCode", args.userCode))
      .unique();

    if (!code) {
      return null;
    }

    return {
      userCode: code.userCode,
      status: code.status,
      machineName: code.machineName ?? null,
      platform: code.platform ?? null,
      arch: code.arch ?? null,
      shell: code.shell ?? null,
      environment: code.environment ?? null,
      runtimeVersion: code.runtimeVersion ?? null,
      preferredProvider: code.preferredProvider ?? null,
      isWsl: code.isWsl ?? false,
      deviceId: code.deviceId ?? null,
      claimed: code.claimedAt !== undefined || (code.status === "authorized" && !code.pendingToken && !code.approvedUserId),
      approvedAt: code.approvedAt ?? null,
      claimedAt: code.claimedAt ?? null,
      expiresAt: code.expiresAt,
      createdAt: code.createdAt,
    };
  },
});

export const getDeviceCodeEvent = query({
  args: { deviceCode: v.string() },
  handler: async (ctx, args) => {
    const code = await ctx.db
      .query("deviceCodes")
      .withIndex("by_deviceCode", (q) => q.eq("deviceCode", args.deviceCode))
      .unique();

    if (!code) return { status: "expired" as const };
    if (code.expiresAt < Date.now()) return { status: "expired" as const, expiresAt: code.expiresAt };
    if (code.status === "authorized") {
      return {
        status: "authorized" as const,
        claimHandle: code.claimHandle ?? null,
        claimed: code.claimedAt !== undefined || (!code.pendingToken && !code.approvedUserId),
        expiresAt: code.expiresAt,
      };
    }
    return { status: code.status as "pending" | "expired", expiresAt: code.expiresAt };
  },
});

export type SessionScope = "full" | "machine" | "tv" | "watch" | "vision" | "spatial";

export function companionSessionScopeForDeviceCode(code: {
  platform?: string;
  environment?: string;
}): Exclude<SessionScope, "machine"> {
  const platform = (code.platform || "").toLowerCase();
  const env = (code.environment || "").toLowerCase();
  if (env === "watch" || platform === "watchos" || platform === "wearos" || platform === "wear-os" || platform === "wear") {
    return "watch";
  }
  if (
    env === "vision" ||
    env === "xr" ||
    env === "ar" ||
    env === "vr" ||
    env === "spatial" ||
    platform === "visionos" ||
    platform === "androidxr" ||
    platform === "android-xr" ||
    platform === "quest" ||
    platform === "meta-quest"
  ) {
    return env === "spatial" ? "spatial" : "vision";
  }
  if (env === "tv" || platform === "tvos" || platform === "androidtv" || platform === "android-tv") {
    return "tv";
  }
  return "full";
}

async function mintTokenForAuthorizedCode(
  ctx: MutationCtx,
  code: {
    _id: Id<"deviceCodes">;
    userCode: string;
    status: "pending" | "authorized" | "expired";
    pendingToken?: string;
    approvedUserId?: Id<"users">;
    deviceId?: string;
    platform?: string;
    environment?: string;
    claimedAt?: number;
  },
) {
  if (code.status !== "authorized") return { status: "expired" as const };
  if (code.claimedAt !== undefined) return { status: "expired" as const };

  if (code.pendingToken) {
    const token = code.pendingToken;
    await ctx.db.patch(code._id, { pendingToken: undefined, claimedAt: Date.now() });
    return { status: "authorized" as const, token };
  }

  if (!code.approvedUserId) return { status: "expired" as const };

  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const tokenHash = await sha256Hex(token);
  await ctx.db.insert("sessions", {
    tokenHash,
    userId: code.approvedUserId,
    deviceId: code.deviceId,
    expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    createdAt: Date.now(),
    scope: companionSessionScopeForDeviceCode(code),
  });
  await ctx.db.patch(code._id, { claimedAt: Date.now() });
  return { status: "authorized" as const, token };
}

/**
 * Poll for device code status. Called by CLI every 5 seconds.
 * Returns status and token (if authorized).
 */
export const pollDeviceCode = mutation({
  args: { deviceCode: v.string() },
  handler: async (ctx, args) => {
    const code = await ctx.db
      .query("deviceCodes")
      .withIndex("by_deviceCode", (q) => q.eq("deviceCode", args.deviceCode))
      .unique();

    if (!code) {
      return { status: "expired" as const };
    }

    if (code.expiresAt < Date.now()) {
      await ctx.db.patch(code._id, { status: "expired" });
      return { status: "expired" as const };
    }

    if (code.status === "authorized") {
      return await mintTokenForAuthorizedCode(ctx, code);
    }

    return { status: "pending" as const };
  },
});

/**
 * Authorize a device code. Called from the web/mobile after the user
 * authenticates, via POST /auth/device-code/authorize which derives `userId`
 * from the caller's bearer token.
 *
 * internalMutation, NOT public: it mints a 1-year session for the `userId`
 * argument. Public exposure would let anyone with the deployment URL create a
 * session for an ARBITRARY userId (userCode phishing with no server-side
 * userCode→initiator binding). The HTTP route is the only legitimate caller
 * and it binds userId to the authenticated session.
 */
export const authorizeDeviceCode = internalMutation({
  args: {
    userCode: v.string(),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const code = await ctx.db
      .query("deviceCodes")
      .withIndex("by_userCode", (q) => q.eq("userCode", args.userCode))
      .unique();

    if (!code) {
      throw new Error("INVALID_CODE");
    }

    if (code.status !== "pending") {
      throw new Error("CODE_ALREADY_USED");
    }

    if (code.expiresAt < Date.now()) {
      await ctx.db.patch(code._id, { status: "expired" });
      throw new Error("CODE_EXPIRED");
    }

    const attempts = (code.authorizeAttempts ?? 0) + 1;
    if (attempts > 8) {
      await ctx.db.patch(code._id, {
        authorizeAttempts: attempts,
        lastAuthorizeAttemptAt: Date.now(),
      });
      throw new Error("TOO_MANY_ATTEMPTS");
    }

    const claimHandle = randomHex(16);
    await ctx.db.patch(code._id, {
      status: "authorized",
      approvedUserId: args.userId,
      approvedAt: Date.now(),
      claimHandle,
      authorizeAttempts: attempts,
      lastAuthorizeAttemptAt: Date.now(),
    });

    return { ok: true, claimHandle };
  },
});

export const claimDeviceCode = mutation({
  args: {
    deviceCode: v.string(),
    claimHandle: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const code = await ctx.db
      .query("deviceCodes")
      .withIndex("by_deviceCode", (q) => q.eq("deviceCode", args.deviceCode))
      .unique();

    if (!code) return { status: "expired" as const };
    if (code.expiresAt < Date.now()) {
      await ctx.db.patch(code._id, { status: "expired" });
      return { status: "expired" as const };
    }
    if (code.claimHandle && args.claimHandle && code.claimHandle !== args.claimHandle) {
      return { status: "pending" as const };
    }
    if (code.claimHandle && !args.claimHandle) {
      return { status: "authorized" as const, claimRequired: true };
    }
    return await mintTokenForAuthorizedCode(ctx, code);
  },
});

async function createAuthorizedDeviceCodeForUser(
  ctx: MutationCtx,
  userId: Id<"users">,
  args: {
    machineName?: string;
    platform?: string;
    arch?: string;
    deviceId?: string;
  },
) {
  const now = Date.now();
  const deviceCode = randomHex(20); // 40-char hex handle injected into the box
  let userCode = generateUserCode();
  // Best-effort uniqueness on the human code (unused in the broker path, kept
  // for schema parity + audit).
  for (let i = 0; i < 5; i++) {
    const clash = await ctx.db
      .query("deviceCodes")
      .withIndex("by_userCode", (q) => q.eq("userCode", userCode))
      .unique();
    if (!clash || clash.status !== "pending") break;
    userCode = generateUserCode();
  }

  // Mint the box's real 1-year session token, bound to the caller's user.
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const tokenHash = await sha256Hex(token);
  await ctx.db.insert("sessions", {
    tokenHash,
    userId,
    deviceId: args.deviceId,
    expiresAt: now + 365 * 24 * 60 * 60 * 1000,
    createdAt: now,
    // Phase 0 of machine-asymmetric-auth-design.md: a brokered box token is
    // MACHINE-scoped, not a full owner login. Recorded now (no enforcement yet)
    // so the box's real call-set can be measured before later phases
    // default-deny account-level ops for machine scope. Backward-compatible:
    // undefined scope elsewhere still means "full".
    scope: "machine" as const,
  });

  // Pre-authorized code: the box picks up `token` exactly once via
  // pollDeviceCode, then it's cleared. Never return the raw token here.
  await ctx.db.insert("deviceCodes", {
    userCode,
    deviceCode,
    status: "authorized",
    pendingToken: token,
    machineName: args.machineName,
    platform: args.platform,
    arch: args.arch,
    expiresAt: now + DEVICE_CODE_TTL_MS,
    createdAt: now,
  });

  return { deviceCode, expiresAt: now + DEVICE_CODE_TTL_MS };
}

/**
 * BROKERED device onboarding — the keystone of seamless, secure remote-box
 * provisioning. An ALREADY-AUTHENTICATED surface (the user's CLI daemon or the
 * mobile app) mints + pre-authorizes a device code for a NEW box in ONE call,
 * so the box inherits the caller's identity with **no interactive OAuth on the
 * box** (no device-code paste, no browser-on-the-server).
 *
 * Security model (matches the arbitrage threat model):
 *   - Gated on the CALLER'S own session (validateSessionInternal). The new box's
 *     session is bound to the SAME user — you can only broker a box into your OWN
 *     account, never someone else's.
 *   - The value returned + injected into the box's cloud-init is only the
 *     short-lived (15-min) deviceCode HANDLE, never the token. The box exchanges
 *     it exactly ONCE via pollDeviceCode (which clears pendingToken on first
 *     read) → the injected handle is worthless after first boot, even though
 *     cloud metadata is rooted-readable.
 *   - deviceCode is 40-char hex (randomHex(20)); the box's real token is a fresh
 *     256-bit secret never exposed to the caller.
 *
 * internalMutation, NOT public: auth here is a caller-SUPPLIED `tokenHash`, so
 * a public export would let anyone who learns a stored session-token hash (DB
 * leak, log line) mint fresh 1-year tokens — no proof-of-possession of the
 * actual bearer. The broker HTTP route (POST /auth/device-code/broker) is the
 * only caller; it authenticates the real bearer and derives the hash itself.
 */
export const createAuthorizedDeviceCode = internalMutation({
  args: {
    tokenHash: v.string(), // caller's session token hash (the broker) — REQUIRED
    machineName: v.optional(v.string()),
    platform: v.optional(v.string()),
    arch: v.optional(v.string()),
    deviceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await validateSessionInternal(ctx, args.tokenHash);
    if (!session) {
      throw new Error("Unauthorized — broker onboarding requires an authenticated caller");
    }

    return await createAuthorizedDeviceCodeForUser(ctx, session.user._id, args);
  },
});

export const createAuthorizedDeviceCodeForUserInternal = internalMutation({
  args: {
    userId: v.id("users"),
    machineName: v.optional(v.string()),
    platform: v.optional(v.string()),
    arch: v.optional(v.string()),
    deviceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await createAuthorizedDeviceCodeForUser(ctx, args.userId, args);
  },
});
