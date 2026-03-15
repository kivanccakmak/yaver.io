import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    userId: v.string(),
    email: v.string(),
    fullName: v.string(),
    provider: v.union(v.literal("google"), v.literal("microsoft"), v.literal("apple"), v.literal("email")),
    passwordHash: v.optional(v.string()),
    surveyCompleted: v.optional(v.boolean()),
    providerId: v.string(),
    avatarUrl: v.optional(v.string()),
    plan: v.optional(v.union(v.literal("free"), v.literal("pro"), v.literal("enterprise"), v.literal("early_access"))),
    createdAt: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_provider", ["provider", "providerId"]),

  sessions: defineTable({
    tokenHash: v.string(),
    userId: v.id("users"),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_userId", ["userId"]),

  devices: defineTable({
    userId: v.id("users"),
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
    isOnline: v.boolean(),
    runnerDown: v.optional(v.boolean()),  // true when runner crashed and all retries exhausted
    lastHeartbeat: v.number(),
    createdAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_deviceId", ["deviceId"]),

  downloads: defineTable({
    platform: v.union(
      v.literal("macos"),
      v.literal("windows"),
      v.literal("linux")
    ),
    arch: v.string(),
    format: v.string(),
    version: v.string(),
    filename: v.string(),
    storageId: v.id("_storage"),
    size: v.number(),
    createdAt: v.number(),
  })
    .index("by_platform", ["platform"])
    .index("by_platform_arch_format", ["platform", "arch", "format"]),

  subscriptions: defineTable({
    userId: v.string(), // matches users.userId
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
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_lemonSqueezySubscriptionId", ["lemonSqueezySubscriptionId"]),

  developerSurveys: defineTable({
    userId: v.id("users"),
    isDeveloper: v.boolean(),
    languages: v.optional(v.array(v.string())),
    experienceLevel: v.optional(v.string()),
    role: v.optional(v.string()),
    companySize: v.optional(v.string()),
    useCase: v.optional(v.string()),
    completedAt: v.number(),
  }).index("by_userId", ["userId"]),

  platformConfig: defineTable({
    key: v.string(),
    value: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  authLogs: defineTable({
    level: v.union(v.literal("info"), v.literal("error"), v.literal("warn")),
    provider: v.string(),
    step: v.string(),
    message: v.string(),
    details: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_createdAt", ["createdAt"]),

  userSettings: defineTable({
    userId: v.id("users"),
    forceRelay: v.optional(v.boolean()),
    runnerId: v.optional(v.string()),
    customRunnerCommand: v.optional(v.string()),
  }).index("by_userId", ["userId"]),

  aiRunners: defineTable({
    runnerId: v.string(),
    name: v.string(),
    command: v.string(),
    args: v.string(), // JSON array as string
    outputMode: v.union(v.literal("stream-json"), v.literal("raw")),
    resumeSupported: v.boolean(),
    resumeArgs: v.optional(v.string()), // JSON array as string
    exitCommand: v.optional(v.string()), // e.g. "/exit", "/quit"
    description: v.string(),
    isDefault: v.optional(v.boolean()),
    sortOrder: v.number(),
  }).index("by_runnerId", ["runnerId"]),

  // Per-minute CPU/RAM metrics from desktop agents (last 1 hour kept)
  deviceMetrics: defineTable({
    deviceId: v.string(),       // matches devices.deviceId
    timestamp: v.number(),      // epoch ms
    cpuPercent: v.number(),     // 0-100
    memoryUsedMb: v.number(),
    memoryTotalMb: v.number(),
  })
    .index("by_deviceId", ["deviceId", "timestamp"]),

  // Device lifecycle events (crashes, restarts, OOM, etc.)
  deviceEvents: defineTable({
    deviceId: v.string(),
    event: v.union(
      v.literal("crash"),
      v.literal("restart"),
      v.literal("oom"),
      v.literal("started"),
      v.literal("stopped"),
    ),
    details: v.optional(v.string()),
    timestamp: v.number(),
  })
    .index("by_deviceId", ["deviceId", "timestamp"]),

  // Runner usage tracking — how long each AI agent ran per task
  runnerUsage: defineTable({
    userId: v.string(),           // owner of the device
    deviceId: v.string(),         // which device ran it
    taskId: v.string(),           // task identifier
    runner: v.string(),           // "claude", "codex", "aider", etc.
    model: v.optional(v.string()), // "sonnet", "opus", etc.
    durationSec: v.number(),      // how many seconds the runner ran
    startedAt: v.number(),        // epoch ms when task started
    finishedAt: v.number(),       // epoch ms when task finished
    source: v.optional(v.string()), // "mobile", "cli", "mcp"
  })
    .index("by_userId", ["userId", "startedAt"])
    .index("by_deviceId", ["deviceId", "startedAt"]),

  mobileStreamLogs: defineTable({
    userId: v.optional(v.string()),
    platform: v.string(),
    appVersion: v.string(),
    buildNumber: v.string(),
    level: v.union(v.literal("info"), v.literal("error"), v.literal("warn")),
    step: v.string(),
    message: v.string(),
    details: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_createdAt", ["createdAt"])
    .index("by_userId", ["userId", "createdAt"]),
});
