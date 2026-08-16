// taskPackages.ts — owner-only Task Package bookkeeping.
//
// Cross-account package allocation used to materialize infraAccessGrants. That
// access model has been removed from Yaver; this module deliberately exposes
// no invite, allocation, acceptance, shared-list, or runner-status API.

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { resolveUser } from "./agentSync";
import { validateSessionInternal } from "./auth";

async function userFromToken(ctx: any, tokenHash: string): Promise<Id<"users">> {
  const session = await validateSessionInternal(ctx, tokenHash);
  if (!session) throw new Error("Unauthorized");
  return session.user._id;
}

// --- agent sync: owner publishes package bookkeeping ------------------------

export const upsertPackage = mutation({
  args: {
    deviceId: v.string(),
    name: v.string(),
    version: v.number(),
    kind: v.string(),
    tier: v.string(),
    description: v.optional(v.string()),
    domains: v.array(v.string()),
    runtimes: v.array(v.string()),
    engines: v.array(v.string()),
    vantageGeo: v.array(v.string()),
    vantageResidential: v.boolean(),
    schedule: v.optional(v.string()),
    consentSummary: v.optional(v.string()),
    willNot: v.array(v.string()),
    dataShown: v.array(v.string()),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    const ownerUserId = await resolveUser(ctx);
    const existing = await ctx.db
      .query("taskPackages")
      .withIndex("by_owner_name", (q: any) =>
        q.eq("ownerUserId", ownerUserId).eq("name", args.name),
      )
      .first();
    const now = Date.now();
    const row = { ...args, ownerUserId, updatedAt: now };
    if (existing) {
      await ctx.db.patch(existing._id, row);
      return { id: existing._id };
    }
    const id = await ctx.db.insert("taskPackages", row);
    return { id };
  },
});

// --- owner: list ------------------------------------------------------------

export const myPackages = query({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    const userId = await userFromToken(ctx, args.tokenHash);
    const pkgs = await ctx.db
      .query("taskPackages")
      .withIndex("by_owner", (q: any) => q.eq("ownerUserId", userId))
      .collect();
    return pkgs.map((p) => ({
      id: p._id, name: p.name, kind: p.kind, tier: p.tier, version: p.version,
      description: p.description ?? "", domains: p.domains, runtimes: p.runtimes,
      engines: p.engines, vantageGeo: p.vantageGeo, status: p.status,
    }));
  },
});
