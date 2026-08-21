import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { validateSessionInternal } from "./auth";
import { validateHandoffDevicePublicMetadata } from "./credentialHandoffDevicePolicy";

export const register = mutation({
  args: {
    tokenHash: v.string(),
    deviceId: v.string(),
    publicKey: v.string(),
    platform: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await validateSessionInternal(ctx, args.tokenHash);
    if (!session) throw new Error("Unauthorized");
    const metadata = validateHandoffDevicePublicMetadata(args);
    const existing = await ctx.db.query("credentialHandoffDevices")
      .withIndex("by_user_device", (q) => q.eq("userId", session.user._id).eq("deviceId", metadata.deviceId))
      .unique();
    const row = { ...metadata, userId: session.user._id, updatedAt: Date.now() };
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("credentialHandoffDevices", row);
    return { ok: true };
  },
});

export const list = query({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    const session = await validateSessionInternal(ctx, args.tokenHash);
    if (!session) throw new Error("Unauthorized");
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const rows = await ctx.db.query("credentialHandoffDevices")
      .withIndex("by_user", (q) => q.eq("userId", session.user._id)).collect();
    return rows.filter((row) => row.updatedAt >= cutoff).map(({ deviceId, publicKey, platform, updatedAt }) => ({
      deviceId, publicKey, platform, updatedAt,
    }));
  },
});
