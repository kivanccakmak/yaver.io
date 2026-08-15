import { v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { validateSessionInternal } from "./auth";
import { runnerCapabilities, runnerClass } from "./validators";

/**
 * Register or update a device for peer discovery.
 * Requires a valid session tokenHash.
 */
export const registerDevice = mutation({
  args: {
    tokenHash: v.string(),
    deviceId: v.string(),
    name: v.string(),
    platform: v.union(
      v.literal("macos"),
      v.literal("windows"),
      v.literal("linux")
    ),
    publicKey: v.optional(v.string()),
    quicHost: v.string(),
    quicPort: v.number(),
  },
  handler: async (ctx, args) => {
    const session = await validateSessionInternal(ctx, args.tokenHash);
    if (!session) throw new Error("Unauthorized");

    const existing = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .unique();

    if (existing) {
      // Only allow the owner to update their own device
      if (existing.userId !== session.user._id) {
        throw new Error("Device belongs to another user");
      }
      if (existing.deviceKind === "cloud-runner" || existing.trust === "yaver-managed") {
        throw new Error("Managed runners require a scoped workload credential");
      }
      await ctx.db.patch(existing._id, {
        name: args.name,
        platform: args.platform,
        publicKey: args.publicKey,
        quicHost: args.quicHost,
        quicPort: args.quicPort,
        isOnline: true,
        lastHeartbeat: Date.now(),
      });
      return existing._id;
    }

    return await ctx.db.insert("devices", {
      userId: session.user._id,
      deviceId: args.deviceId,
      name: args.name,
      platform: args.platform,
      publicKey: args.publicKey,
      quicHost: args.quicHost,
      quicPort: args.quicPort,
      isOnline: true,
      deviceKind: "private-agent",
      trust: "user-managed",
      lastHeartbeat: Date.now(),
      createdAt: Date.now(),
    });
  },
});

/**
 * Update device heartbeat — marks it as online.
 */
export const heartbeat = mutation({
  args: {
    tokenHash: v.string(),
    deviceId: v.string(),
    runners: v.optional(v.array(v.object({
      taskId: v.string(),
      runnerId: v.string(),
      model: v.optional(v.string()),
      pid: v.number(),
      status: v.string(),
      title: v.string(),
    }))),
    quicHost: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await validateSessionInternal(ctx, args.tokenHash);
    if (!session) throw new Error("Unauthorized");

    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .unique();

    if (!device) throw new Error("Device not found");
    if (device.userId !== session.user._id) throw new Error("Unauthorized");
    if (device.deviceKind === "cloud-runner" || device.trust === "yaver-managed") {
      throw new Error("Managed runners require a scoped workload credential");
    }

    const patch: Record<string, unknown> = {
      isOnline: true,
      lastHeartbeat: Date.now(),
      runners: args.runners ?? [],
    };
    // Update stored IP if the agent reports a new one
    if (args.quicHost && args.quicHost !== device.quicHost) {
      patch.quicHost = args.quicHost;
    }
    await ctx.db.patch(device._id, patch);
  },
});

/**
 * List all devices belonging to the authenticated user.
 */
export const listMyDevices = query({
  args: {
    tokenHash: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await validateSessionInternal(ctx, args.tokenHash);
    if (!session) throw new Error("Unauthorized");

    const [devices, access, workspaces] = await Promise.all([
      ctx.db.query("devices").withIndex("by_userId", (q) => q.eq("userId", session.user._id)).collect(),
      ctx.db.query("cloudAccess").withIndex("by_userId", (q) => q.eq("userId", session.user._id)).first(),
      ctx.db.query("cloudWorkspaces").withIndex("by_userId", (q) => q.eq("userId", session.user._id)).collect(),
    ]);
    const cloudAccessActive = access?.status === "active" && (!access.validUntil || access.validUntil > Date.now());
    const readyWorkspaceIds = new Set(workspaces.filter((workspace) => workspace.state === "ready").map((workspace) => workspace.cloudWorkspaceId));

    return devices.filter((device) => device.deviceKind !== "cloud-runner" || (
      cloudAccessActive && !!device.cloudWorkspaceId && readyWorkspaceIds.has(device.cloudWorkspaceId)
    )).map((d) => ({
      deviceId: d.deviceId,
      name: d.name,
      platform: d.platform,
      publicKey: d.publicKey,
      quicHost: d.quicHost,
      quicPort: d.quicPort,
      isOnline: d.isOnline,
      deviceKind: d.deviceKind ?? "private-agent",
      trust: d.trust ?? "user-managed",
      cloudWorkspaceId: d.cloudWorkspaceId,
      runnerClass: d.runnerClass,
      region: d.region,
      agentVersion: d.agentVersion,
      protocolVersion: d.protocolVersion,
      capabilities: d.capabilities,
      runnerDown: d.runnerDown ?? false,
      runners: d.runners ?? [],
      lastHeartbeat: d.lastHeartbeat,
    }));
  },
});

async function requireWorkload(
  ctx: MutationCtx,
  tokenHash: string,
  runnerDeviceId: string,
) {
  const credential = await ctx.db
    .query("workloadCredentials")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
  if (!credential || credential.status !== "active" || credential.expiresAt <= Date.now()) {
    throw new Error("Invalid workload credential");
  }
  if (credential.runnerDeviceId !== runnerDeviceId) throw new Error("Workload credential is bound to another runner");
  const workspace = await ctx.db
    .query("cloudWorkspaces")
    .withIndex("by_workspaceId", (q) => q.eq("cloudWorkspaceId", credential.cloudWorkspaceId))
    .unique();
  if (!workspace || workspace.userId !== credential.userId || workspace.runnerDeviceId !== runnerDeviceId) {
    throw new Error("Cloud Workspace scope mismatch");
  }
  if (workspace.state !== "provisioning" && workspace.state !== "ready") {
    throw new Error("Cloud Workspace is not accepting runner traffic");
  }
  const access = await ctx.db.query("cloudAccess").withIndex("by_userId", (q) => q.eq("userId", credential.userId)).first();
  if (!access || access.status !== "active" || (access.validUntil && access.validUntil <= Date.now())) {
    throw new Error("Cloud access is not active");
  }
  return { credential, workspace };
}

/** Managed runners never register with a general user session. */
export const registerManagedRunner = mutation({
  args: {
    tokenHash: v.string(),
    deviceId: v.string(),
    name: v.string(),
    platform: v.union(v.literal("macos"), v.literal("linux")),
    publicKey: v.optional(v.string()),
    quicHost: v.string(),
    quicPort: v.number(),
    runnerClass,
    region: v.string(),
    agentVersion: v.string(),
    protocolVersion: v.number(),
    capabilities: runnerCapabilities,
  },
  handler: async (ctx, args) => {
    const { credential } = await requireWorkload(ctx, args.tokenHash, args.deviceId);
    if (args.platform !== args.runnerClass) throw new Error("Runner platform/class mismatch");
    const existing = await ctx.db.query("devices").withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId)).unique();
    const value = {
      userId: credential.userId,
      deviceId: args.deviceId,
      name: args.name,
      platform: args.platform,
      publicKey: args.publicKey,
      quicHost: args.quicHost,
      quicPort: args.quicPort,
      isOnline: true,
      deviceKind: "cloud-runner" as const,
      trust: "yaver-managed" as const,
      cloudWorkspaceId: credential.cloudWorkspaceId,
      runnerClass: args.runnerClass,
      region: args.region,
      agentVersion: args.agentVersion,
      protocolVersion: args.protocolVersion,
      capabilities: args.capabilities,
      lastHeartbeat: Date.now(),
    };
    if (existing) {
      if (existing.userId !== credential.userId || existing.deviceKind !== "cloud-runner") {
        throw new Error("Runner device ID is already registered");
      }
      await ctx.db.patch(existing._id, value);
      await ctx.db.patch(credential._id, { lastUsedAt: Date.now() });
      const user = await ctx.db.get(credential.userId);
      if (!user) throw new Error("Cloud Workspace owner not found");
      return { deviceId: existing._id, ownerUserId: user.userId };
    }
    const id = await ctx.db.insert("devices", { ...value, createdAt: Date.now() });
    await ctx.db.patch(credential._id, { lastUsedAt: Date.now() });
    const user = await ctx.db.get(credential.userId);
    if (!user) throw new Error("Cloud Workspace owner not found");
    return { deviceId: id, ownerUserId: user.userId };
  },
});

export const managedHeartbeat = mutation({
  args: {
    tokenHash: v.string(),
    deviceId: v.string(),
    runners: v.optional(v.array(v.object({
      taskId: v.string(), runnerId: v.string(), model: v.optional(v.string()),
      pid: v.number(), status: v.string(), title: v.string(),
    }))),
    quicHost: v.optional(v.string()),
    agentVersion: v.string(),
    protocolVersion: v.number(),
    capabilities: runnerCapabilities,
  },
  handler: async (ctx, args) => {
    const { credential } = await requireWorkload(ctx, args.tokenHash, args.deviceId);
    const device = await ctx.db.query("devices").withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId)).unique();
    if (!device || device.userId !== credential.userId || device.deviceKind !== "cloud-runner") {
      throw new Error("Managed runner not registered");
    }
    await ctx.db.patch(device._id, {
      isOnline: true,
      lastHeartbeat: Date.now(),
      runners: args.runners ?? [],
      quicHost: args.quicHost ?? device.quicHost,
      agentVersion: args.agentVersion,
      protocolVersion: args.protocolVersion,
      capabilities: args.capabilities,
    });
    await ctx.db.patch(credential._id, { lastUsedAt: Date.now() });
  },
});

export const managedOffline = mutation({
  args: { tokenHash: v.string(), deviceId: v.string() },
  handler: async (ctx, args) => {
    const { credential } = await requireWorkload(ctx, args.tokenHash, args.deviceId);
    const device = await ctx.db.query("devices").withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId)).unique();
    if (!device || device.userId !== credential.userId || device.deviceKind !== "cloud-runner") {
      throw new Error("Managed runner not registered");
    }
    await ctx.db.patch(device._id, { isOnline: false, lastHeartbeat: Date.now(), runners: [] });
    await ctx.db.patch(credential._id, { lastUsedAt: Date.now() });
  },
});

/**
 * Update the runnerDown flag for a device.
 * Called by the desktop agent when runner crashes with all retries exhausted,
 * or when runner is successfully restarted.
 */
export const setRunnerDown = mutation({
  args: {
    tokenHash: v.string(),
    deviceId: v.string(),
    runnerDown: v.boolean(),
  },
  handler: async (ctx, args) => {
    const session = await validateSessionInternal(ctx, args.tokenHash);
    if (!session) throw new Error("Unauthorized");

    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .unique();

    if (!device) throw new Error("Device not found");
    if (device.userId !== session.user._id) throw new Error("Unauthorized");
    if (device.deviceKind === "cloud-runner" || device.trust === "yaver-managed") {
      throw new Error("Managed runner state requires a workload credential");
    }

    await ctx.db.patch(device._id, { runnerDown: args.runnerDown });
  },
});

/**
 * Mark a device as offline.
 * Called by the desktop agent on stop/signout.
 */
export const markOffline = mutation({
  args: {
    tokenHash: v.string(),
    deviceId: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await validateSessionInternal(ctx, args.tokenHash);
    if (!session) throw new Error("Unauthorized");

    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .unique();

    if (!device) throw new Error("Device not found");
    if (device.userId !== session.user._id) throw new Error("Unauthorized");
    if (device.deviceKind === "cloud-runner" || device.trust === "yaver-managed") {
      throw new Error("Managed runner state requires a workload credential");
    }

    await ctx.db.patch(device._id, {
      isOnline: false,
      lastHeartbeat: Date.now(),
    });
  },
});

/**
 * Remove (unregister) a device.
 */
export const removeDevice = mutation({
  args: {
    tokenHash: v.string(),
    deviceId: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await validateSessionInternal(ctx, args.tokenHash);
    if (!session) throw new Error("Unauthorized");

    const device = await ctx.db
      .query("devices")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", args.deviceId))
      .unique();

    if (!device) throw new Error("Device not found");
    if (device.userId !== session.user._id) throw new Error("Unauthorized");
    if (device.deviceKind === "cloud-runner" || device.trust === "yaver-managed") {
      throw new Error("Managed runners are removed by the Cloud Workspace controller");
    }

    await ctx.db.delete(device._id);
  },
});
