import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { validateSessionInternal } from "./auth";
import {
  cloudAccessStatus,
  cloudWorkspaceState,
  gitConnectionStatus,
  runnerClass,
} from "./validators";

/** Apple and other clients consume this neutral availability document. It has
 * no prices, checkout URLs, or client-writable entitlement fields. */
export const getStatusByToken = query({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    const session = await validateSessionInternal(ctx, args.tokenHash);
    if (!session) throw new Error("Unauthorized");
    const userId = session.user._id;
    const [access, workspaces, gitConnections] = await Promise.all([
      ctx.db.query("cloudAccess").withIndex("by_userId", (q) => q.eq("userId", userId)).first(),
      ctx.db.query("cloudWorkspaces").withIndex("by_userId", (q) => q.eq("userId", userId)).collect(),
      ctx.db.query("gitConnections").withIndex("by_userId", (q) => q.eq("userId", userId)).collect(),
    ]);
    const now = Date.now();
    const accessActive = access?.status === "active" && (!access.validUntil || access.validUntil > now);
    const effectiveAccessStatus = access?.status === "active" && access.validUntil && access.validUntil <= now
      ? "expired"
      : access?.status ?? "inactive";
    return {
      access: {
        status: effectiveAccessStatus,
        maxCloudWorkspaces: accessActive ? access?.maxCloudWorkspaces ?? 0 : 0,
        maxConcurrentTasks: accessActive ? access?.maxConcurrentTasks ?? 0 : 0,
        maxConcurrentPreviews: accessActive ? access?.maxConcurrentPreviews ?? 0 : 0,
        allowedRunnerClasses: accessActive ? access?.allowedRunnerClasses ?? [] : [],
      },
      workspaces: workspaces.map((workspace) => ({
        cloudWorkspaceId: workspace.cloudWorkspaceId,
        runnerDeviceId: workspace.runnerDeviceId,
        runnerClass: workspace.runnerClass,
        region: workspace.region,
        state: workspace.state,
        lastReadyAt: workspace.lastReadyAt,
      })),
      gitConnections: gitConnections.map((connection) => ({
        gitConnectionId: connection.gitConnectionId,
        provider: connection.provider,
        externalAccountId: connection.externalAccountId,
        displayName: connection.displayName,
        status: connection.status,
      })),
    };
  },
});

/** Trusted provisioning hooks. They are internal Convex mutations and cannot
 * be called by mobile, tvOS, web clients, or ordinary user sessions. */
export const provisionAccess = internalMutation({
  args: {
    userId: v.id("users"),
    status: cloudAccessStatus,
    maxCloudWorkspaces: v.number(),
    maxConcurrentTasks: v.number(),
    maxConcurrentPreviews: v.number(),
    allowedRunnerClasses: v.array(runnerClass),
    validUntil: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("cloudAccess").withIndex("by_userId", (q) => q.eq("userId", args.userId)).first();
    const now = Date.now();
    const value = { ...args, updatedAt: now };
    if (existing) {
      await ctx.db.patch(existing._id, value);
      return existing._id;
    }
    return await ctx.db.insert("cloudAccess", { ...value, createdAt: now });
  },
});

export const upsertCloudWorkspace = internalMutation({
  args: {
    userId: v.id("users"),
    cloudWorkspaceId: v.string(),
    runnerDeviceId: v.string(),
    runnerClass,
    region: v.string(),
    state: cloudWorkspaceState,
    capabilitiesDigest: v.optional(v.string()),
    lastReadyAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("cloudWorkspaces").withIndex("by_workspaceId", (q) => q.eq("cloudWorkspaceId", args.cloudWorkspaceId)).unique();
    const now = Date.now();
    const value = { ...args, updatedAt: now };
    if (existing) {
      if (existing.userId !== args.userId) throw new Error("Cloud Workspace belongs to another user");
      await ctx.db.patch(existing._id, value);
      return existing._id;
    }
    return await ctx.db.insert("cloudWorkspaces", { ...value, createdAt: now });
  },
});

export const upsertGitConnection = internalMutation({
  args: {
    userId: v.id("users"),
    gitConnectionId: v.string(),
    provider: v.union(v.literal("github"), v.literal("gitlab")),
    externalAccountId: v.string(),
    displayName: v.string(),
    status: gitConnectionStatus,
    credentialReference: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("gitConnections").withIndex("by_connectionId", (q) => q.eq("gitConnectionId", args.gitConnectionId)).unique();
    const now = Date.now();
    const value = { ...args, updatedAt: now };
    if (existing) {
      if (existing.userId !== args.userId) throw new Error("Git Connection belongs to another user");
      await ctx.db.patch(existing._id, value);
      return existing._id;
    }
    return await ctx.db.insert("gitConnections", { ...value, createdAt: now });
  },
});

export const issueWorkloadCredential = internalMutation({
  args: {
    userId: v.id("users"),
    tokenHash: v.string(),
    cloudWorkspaceId: v.string(),
    runnerDeviceId: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.query("cloudWorkspaces").withIndex("by_workspaceId", (q) => q.eq("cloudWorkspaceId", args.cloudWorkspaceId)).unique();
    if (!workspace || workspace.userId !== args.userId || workspace.runnerDeviceId !== args.runnerDeviceId) {
      throw new Error("Workload credential scope does not match a Cloud Workspace");
    }
    return await ctx.db.insert("workloadCredentials", {
      ...args,
      status: "active",
      createdAt: Date.now(),
    });
  },
});

export const revokeWorkspaceCredentials = internalMutation({
  args: {
    userId: v.id("users"),
    cloudWorkspaceId: v.string(),
  },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.query("cloudWorkspaces").withIndex("by_workspaceId", (q) => q.eq("cloudWorkspaceId", args.cloudWorkspaceId)).unique();
    if (!workspace || workspace.userId !== args.userId) throw new Error("Cloud Workspace scope mismatch");
    const credentials = await ctx.db.query("workloadCredentials").withIndex("by_workspaceId", (q) => q.eq("cloudWorkspaceId", args.cloudWorkspaceId)).collect();
    const revokedAt = Date.now();
    for (const credential of credentials) {
      if (credential.userId === args.userId && credential.status === "active") {
        await ctx.db.patch(credential._id, { status: "revoked", revokedAt });
      }
    }
    return { revoked: credentials.filter((credential) => credential.userId === args.userId && credential.status === "active").length };
  },
});
