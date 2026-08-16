// projectArtifacts.ts — private owner build/output artifact ledger.
//
// Stores metadata and URL/object pointers only. Do not put local filesystem
// paths, build stdout, prompts, secrets, provider credentials, or VM internals
// in this table.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { validateSessionInternal } from "./auth";

const artifactKinds = new Set(["apk", "hermes", "web-preview", "screenshot", "log", "bundle", "other"]);
const providers = new Set(["yaver-storage", "external", "convex", "s3", "r2"]);
const storageMeteredProviders = new Set(["yaver-storage", "convex", "s3", "r2"]);
const defaultIncludedArtifactBytes = 1024 * 1024 * 1024;

async function userFromToken(ctx: any, tokenHash: string): Promise<Id<"users">> {
  const session = await validateSessionInternal(ctx, tokenHash);
  if (!session) throw new Error("Unauthorized");
  return session.user._id;
}

function trimLabel(value: unknown, max: number): string | undefined {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : undefined;
}

function normalizeProjectSlug(slug: string | undefined): string | undefined {
  const s = String(slug || "").trim();
  if (!s || /[\\/]/.test(s)) return undefined;
  return s.slice(0, 80);
}

export function normalizeArtifactKind(kind: unknown): string {
  const raw = String(kind || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return artifactKinds.has(raw) ? raw : "other";
}

export function normalizeArtifactProvider(provider: unknown): string {
  const raw = String(provider || "").trim().toLowerCase();
  return providers.has(raw) ? raw : "external";
}

export function normalizeArtifactUrl(url: unknown): string | undefined {
  const raw = String(url ?? "").trim();
  if (!raw) return undefined;
  if (raw.length > 2048) throw new Error("artifact url too long");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("artifact url must be absolute https");
  }
  if (parsed.protocol !== "https:") throw new Error("artifact url must be https");
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

export function normalizeObjectKey(value: unknown): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  if (raw.length > 512) throw new Error("artifact object key too long");
  if (raw.includes("\x00") || raw.startsWith("/") || raw.includes("..")) {
    throw new Error("unsafe artifact object key");
  }
  return raw;
}

export function normalizeArtifactSizeBytes(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.floor(n));
}

export function includedArtifactStorageBytes(envValue = process.env.YAVER_ARTIFACT_INCLUDED_BYTES): number {
  const parsed = Number(envValue);
  if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  return defaultIncludedArtifactBytes;
}

function meteredArtifactBytes(row: { provider?: string; sizeBytes?: number; status?: string; expiresAt?: number }, now: number): number {
  if (row.status !== "active") return 0;
  if (row.expiresAt && row.expiresAt <= now) return 0;
  if (!storageMeteredProviders.has(String(row.provider || ""))) return 0;
  if (!Number.isFinite(row.sizeBytes || 0)) return 0;
  return Math.max(0, Math.floor(row.sizeBytes || 0));
}

export function summarizeArtifactUsage(
  rows: Array<{ kind?: string; provider?: string; sizeBytes?: number; visibility?: string; status?: string; expiresAt?: number; createdAt?: number }>,
  now = Date.now(),
  quotaBytes = includedArtifactStorageBytes(),
  reservedUploadBytes = 0,
) {
  const byKind: Record<string, number> = {};
  let activeCount = 0;
  let storageBytes = 0;
  let oldestCreatedAt: number | null = null;
  let newestCreatedAt: number | null = null;
  for (const row of rows) {
    if (row.status !== "active") continue;
    if (row.expiresAt && row.expiresAt <= now) continue;
    activeCount += 1;
    const kind = normalizeArtifactKind(row.kind);
    byKind[kind] = (byKind[kind] || 0) + 1;
    storageBytes += meteredArtifactBytes(row, now);
    if (typeof row.createdAt === "number") {
      oldestCreatedAt = oldestCreatedAt === null ? row.createdAt : Math.min(oldestCreatedAt, row.createdAt);
      newestCreatedAt = newestCreatedAt === null ? row.createdAt : Math.max(newestCreatedAt, row.createdAt);
    }
  }
  const totalMeteredBytes = storageBytes + Math.max(0, Math.floor(reservedUploadBytes || 0));
  const remainingBytes = Math.max(0, quotaBytes - totalMeteredBytes);
  return {
    activeCount,
    storageBytes,
    reservedUploadBytes: Math.max(0, Math.floor(reservedUploadBytes || 0)),
    totalMeteredBytes,
    quotaBytes,
    remainingBytes,
    quotaPercent: quotaBytes > 0 ? Math.min(1, totalMeteredBytes / quotaBytes) : 0,
    overQuota: quotaBytes > 0 && totalMeteredBytes > quotaBytes,
    byKind,
    oldestCreatedAt,
    newestCreatedAt,
  };
}

async function ownerPendingUploadBytes(
  ctx: any,
  ownerUserId: Id<"users">,
  excludeUploadIntentId?: Id<"projectArtifactUploadIntents">,
) {
  const rows = await ctx.db
    .query("projectArtifactUploadIntents")
    .withIndex("by_owner_status", (q: any) => q.eq("ownerUserId", ownerUserId).eq("status", "pending"))
    .collect();
  return rows.reduce((sum: number, row: any) => {
    if (excludeUploadIntentId && String(row._id) === String(excludeUploadIntentId)) return sum;
    return sum + Math.max(0, Math.floor(row.sizeBytes || 0));
  }, 0);
}

async function ownerArtifactRows(ctx: any, ownerUserId: Id<"users">) {
  return await ctx.db
    .query("projectArtifacts")
    .withIndex("by_owner_created", (q: any) => q.eq("ownerUserId", ownerUserId))
    .collect();
}

async function enforceOwnerStorageQuota(
  ctx: any,
  ownerUserId: Id<"users">,
  addedBytes: number,
  now: number,
) {
  if (addedBytes <= 0) return;
  const quotaBytes = includedArtifactStorageBytes();
  if (quotaBytes <= 0) return;
  const rows = await ownerArtifactRows(ctx, ownerUserId);
  const reservedUploadBytes = await ownerPendingUploadBytes(ctx, ownerUserId);
  const usage = summarizeArtifactUsage(rows, now, quotaBytes, reservedUploadBytes);
  if (usage.totalMeteredBytes + addedBytes > quotaBytes) {
    throw new Error(`artifact storage quota exceeded: ${usage.totalMeteredBytes + addedBytes}/${quotaBytes} bytes`);
  }
}

function requireProjectSlug(value: string | undefined): string {
  const slug = normalizeProjectSlug(value);
  if (!slug) throw new Error("projectSlug required");
  return slug;
}

async function requireManagedArtifactStorageEntitlement(ctx: any, userId: Id<"users">) {
  const ok = await ctx.runQuery(internal.subscriptions.canUseManagedArtifactStorage, { userId });
  if (!ok) {
    throw new Error("Yaver artifact storage requires Cloud Workspace. Save an external HTTPS artifact link instead.");
  }
}

function serialize(row: any, includePrivate = false) {
  return {
    id: row._id,
    taskId: row.taskId ?? null,
    localTaskId: row.localTaskId ?? null,
    projectSlug: row.projectSlug,
    kind: row.kind,
    title: row.title,
    description: row.description ?? null,
    provider: row.provider,
    url: row.url ?? null,
    contentType: row.contentType ?? null,
    sizeBytes: row.sizeBytes ?? null,
    checksum: row.checksum ?? null,
    visibility: row.visibility,
    expiresAt: row.expiresAt ?? null,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastAccessedAt: row.lastAccessedAt ?? null,
    ...(includePrivate ? { storageId: row.storageId ?? null, objectKey: row.objectKey ?? null } : {}),
  };
}

export const generateUploadUrl = mutation({
  args: {
    tokenHash: v.string(),
    projectSlug: v.string(),
    sizeBytes: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await userFromToken(ctx, args.tokenHash);
    const projectSlug = requireProjectSlug(args.projectSlug);
    await requireManagedArtifactStorageEntitlement(ctx, userId);
    const sizeBytes = normalizeArtifactSizeBytes(args.sizeBytes);
    if (!sizeBytes || sizeBytes <= 0) throw new Error("upload sizeBytes must be positive");
    const now = Date.now();
    await enforceOwnerStorageQuota(ctx, userId, sizeBytes, now);
    const uploadIntentId = await ctx.db.insert("projectArtifactUploadIntents", {
      userId,
      ownerUserId: userId,
      projectSlug,
      sizeBytes,
      status: "pending" as const,
      createdAt: now,
      updatedAt: now,
    });
    return {
      uploadUrl: await ctx.storage.generateUploadUrl(),
      uploadIntentId,
      sizeBytes,
    };
  },
});

export const create = mutation({
  args: {
    tokenHash: v.string(),
    projectSlug: v.string(),
    taskId: v.optional(v.string()),
    localTaskId: v.optional(v.string()),
    kind: v.optional(v.string()),
    title: v.string(),
    description: v.optional(v.string()),
    provider: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    uploadIntentId: v.optional(v.id("projectArtifactUploadIntents")),
    objectKey: v.optional(v.string()),
    url: v.optional(v.string()),
    contentType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
    checksum: v.optional(v.string()),
    visibility: v.optional(v.union(v.literal("private"), v.literal("project"))),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await userFromToken(ctx, args.tokenHash);
    const projectSlug = requireProjectSlug(args.projectSlug);
    const title = trimLabel(args.title, 140);
    if (!title) throw new Error("title required");
    const visibility = args.visibility ?? "project";
    const now = Date.now();
    let provider = normalizeArtifactProvider(args.provider);
    let url = normalizeArtifactUrl(args.url);
    let objectKey = normalizeObjectKey(args.objectKey);
    let actualStorageSizeBytes: number | undefined;
    let actualStorageContentType: string | undefined;
    if (args.storageId) {
      await requireManagedArtifactStorageEntitlement(ctx, userId);
      provider = "convex";
      objectKey = String(args.storageId);
      url = url ?? (await ctx.storage.getUrl(args.storageId) ?? undefined);
      const metadata = await ctx.storage.getMetadata(args.storageId);
      if (!metadata) throw new Error("uploaded artifact storage object not found");
      actualStorageSizeBytes = normalizeArtifactSizeBytes(metadata.size);
      actualStorageContentType = metadata.contentType || undefined;
    }
    const sizeBytes = actualStorageSizeBytes ?? normalizeArtifactSizeBytes(args.sizeBytes);
    let uploadIntent: any = null;
    if (args.storageId && (!sizeBytes || sizeBytes <= 0)) {
      try {
        await ctx.storage.delete(args.storageId);
      } catch {
        // Best-effort orphan cleanup; the hard requirement is refusing unmetered storage.
      }
      throw new Error("storage-backed artifacts require positive sizeBytes");
    }
    if (args.storageId) {
      if (!args.uploadIntentId) {
        try {
          await ctx.storage.delete(args.storageId);
        } catch {
          // Best-effort orphan cleanup; metadata must be tied to a quota reservation.
        }
        throw new Error("storage-backed artifacts require an uploadIntentId");
      }
      uploadIntent = await ctx.db.get(args.uploadIntentId);
      const uploadIntentValid =
        uploadIntent &&
        uploadIntent.status === "pending" &&
        String(uploadIntent.userId) === String(userId) &&
        String(uploadIntent.ownerUserId) === String(userId) &&
        uploadIntent.projectSlug === projectSlug &&
        Math.max(0, Math.floor(uploadIntent.sizeBytes || 0)) >= (actualStorageSizeBytes || sizeBytes || 0);
      if (!uploadIntentValid) {
        try {
          await ctx.storage.delete(args.storageId);
        } catch {
          // Best-effort orphan cleanup; invalid reservations must not attach storage.
        }
        throw new Error("artifact upload reservation not found");
      }
    }
    const storageBytes = meteredArtifactBytes(
      {
        provider,
        sizeBytes,
        status: "active",
        expiresAt: args.expiresAt,
      },
      now,
    );
    if (!uploadIntent) {
      try {
        await enforceOwnerStorageQuota(ctx, userId, storageBytes, now);
      } catch (err) {
        if (args.storageId) {
          try {
            await ctx.storage.delete(args.storageId);
          } catch {
            // Best-effort orphan cleanup; quota refusal must still be returned.
          }
        }
        throw err;
      }
    }
    if (uploadIntent && storageBytes > Math.max(0, Math.floor(uploadIntent.sizeBytes || 0))) {
      if (args.storageId) {
        try {
          await ctx.storage.delete(args.storageId);
        } catch {
          // Best-effort orphan cleanup; oversized uploads must still be refused.
        }
      }
      throw new Error("artifact upload exceeds reserved sizeBytes");
    }
    const patch = {
      userId,
      ownerUserId: userId,
      taskId: trimLabel(args.taskId, 160),
      localTaskId: trimLabel(args.localTaskId, 160),
      projectSlug,
      kind: normalizeArtifactKind(args.kind),
      title,
      description: trimLabel(args.description, 280),
      provider,
      storageId: args.storageId,
      objectKey,
      url,
      contentType: trimLabel(actualStorageContentType || args.contentType, 120),
      sizeBytes,
      checksum: trimLabel(args.checksum, 160),
      visibility,
      expiresAt: args.expiresAt,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    };
    if (!patch.url && !patch.objectKey && !patch.storageId) throw new Error("artifact url, storageId, or objectKey required");
    const id = await ctx.db.insert("projectArtifacts", patch);
    if (uploadIntent) {
      await ctx.db.patch(uploadIntent._id, {
        status: "consumed",
        storageId: args.storageId,
        artifactId: id,
        updatedAt: now,
      });
    }
    const row = await ctx.db.get(id);
    if (!row) throw new Error("artifact insert failed");
    return serialize(row, true);
  },
});

export const usage = query({
  args: {
    tokenHash: v.string(),
    projectSlug: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await userFromToken(ctx, args.tokenHash);
    const projectSlug = requireProjectSlug(args.projectSlug);
    const now = Date.now();
    const quotaBytes = includedArtifactStorageBytes();
    const projectRows = await ctx.db
      .query("projectArtifacts")
      .withIndex("by_owner_project_created", (q: any) => q.eq("ownerUserId", userId).eq("projectSlug", projectSlug))
      .collect();
    const ownerRows = await ownerArtifactRows(ctx, userId);
    const projectReservedUploadBytes = await ctx.db
      .query("projectArtifactUploadIntents")
      .withIndex("by_owner_project_status", (q: any) => q.eq("ownerUserId", userId).eq("projectSlug", projectSlug).eq("status", "pending"))
      .collect()
      .then((rows: any[]) => rows.reduce((sum, row) => sum + Math.max(0, Math.floor(row.sizeBytes || 0)), 0));
    const ownerReservedUploadBytes = await ownerPendingUploadBytes(ctx, userId);
    return {
      projectSlug,
      project: summarizeArtifactUsage(projectRows, now, quotaBytes, projectReservedUploadBytes),
      owner: summarizeArtifactUsage(ownerRows, now, quotaBytes, ownerReservedUploadBytes),
    };
  },
});

export const cleanupExpired = mutation({
  args: {
    tokenHash: v.string(),
    projectSlug: v.string(),
    limit: v.optional(v.number()),
    deleteStorage: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await userFromToken(ctx, args.tokenHash);
    const projectSlug = requireProjectSlug(args.projectSlug);
    const now = Date.now();
    const limit = Math.max(1, Math.min(args.limit ?? 50, 200));
    const rows = await ctx.db
      .query("projectArtifacts")
      .withIndex("by_owner_project_created", (q: any) => q.eq("ownerUserId", userId).eq("projectSlug", projectSlug))
      .collect();
    const expired = rows
      .filter((row: any) => row.status === "active")
      .filter((row: any) => row.expiresAt && row.expiresAt <= now)
      .sort((a: any, b: any) => (a.expiresAt || 0) - (b.expiresAt || 0))
      .slice(0, limit);
    let storageDeleteAttempted = 0;
    let storageDeleteFailed = 0;
    for (const row of expired) {
      if (args.deleteStorage !== false && row.storageId) {
        storageDeleteAttempted += 1;
        try {
          await ctx.storage.delete(row.storageId);
        } catch {
          storageDeleteFailed += 1;
        }
      }
      await ctx.db.patch(row._id, { status: "expired", updatedAt: now });
    }
    return {
      ok: true,
      projectSlug,
      scanned: rows.length,
      expired: expired.length,
      storageDeleteAttempted,
      storageDeleteFailed,
      remainingExpired: Math.max(0, rows.filter((row: any) => row.status === "active" && row.expiresAt && row.expiresAt <= now).length - expired.length),
    };
  },
});

export const list = query({
  args: {
    tokenHash: v.string(),
    projectSlug: v.string(),
    kind: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await userFromToken(ctx, args.tokenHash);
    const projectSlug = requireProjectSlug(args.projectSlug);
    const limit = Math.max(1, Math.min(args.limit ?? 50, 100));
    const kind = args.kind ? normalizeArtifactKind(args.kind) : undefined;
    const rows = kind
      ? await ctx.db
          .query("projectArtifacts")
          .withIndex("by_owner_project_kind_created", (q: any) => q.eq("ownerUserId", userId).eq("projectSlug", projectSlug).eq("kind", kind))
          .order("desc")
          .take(limit)
      : await ctx.db
          .query("projectArtifacts")
          .withIndex("by_owner_project_created", (q: any) => q.eq("ownerUserId", userId).eq("projectSlug", projectSlug))
          .order("desc")
          .take(limit);
    const now = Date.now();
    return rows
      .filter((row: any) => row.status === "active")
      .filter((row: any) => !row.expiresAt || row.expiresAt > now)
      .map((row: any) => serialize(row, false));
  },
});

export const hide = mutation({
  args: {
    tokenHash: v.string(),
    artifactId: v.id("projectArtifacts"),
  },
  handler: async (ctx, args) => {
    const userId = await userFromToken(ctx, args.tokenHash);
    const row = await ctx.db.get(args.artifactId);
    if (!row || row.status === "deleted") throw new Error("artifact not found");
    if (String(row.ownerUserId) !== String(userId) && String(row.userId) !== String(userId)) {
      throw new Error("artifact not found");
    }
    const now = Date.now();
    await ctx.db.patch(row._id, { status: "hidden", updatedAt: now });
    return serialize({ ...row, status: "hidden", updatedAt: now });
  },
});
