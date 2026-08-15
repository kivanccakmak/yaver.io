import { v } from "convex/values";

export const deviceKind = v.union(v.literal("private-agent"), v.literal("cloud-runner"));
export const deviceTrust = v.union(v.literal("user-managed"), v.literal("yaver-managed"));
export const runnerClass = v.union(v.literal("linux"), v.literal("macos"));

/** Live facts reported by a runner. Entitlement and quota decisions never use
 * this document as authority. */
export const runnerCapabilities = v.object({
  git: v.boolean(),
  shell: v.boolean(),
  docker: v.boolean(),
  lint: v.boolean(),
  typecheck: v.boolean(),
  compile: v.boolean(),
  test: v.boolean(),
  browserFrames: v.boolean(),
  androidEmulator: v.boolean(),
  iosSimulator: v.boolean(),
  tvosSimulator: v.boolean(),
  webrtc: v.boolean(),
});

export const cloudAccessStatus = v.union(
  v.literal("active"),
  v.literal("inactive"),
  v.literal("suspended"),
);

export const cloudWorkspaceState = v.union(
  v.literal("provisioning"),
  v.literal("ready"),
  v.literal("sleeping"),
  v.literal("starting"),
  v.literal("unavailable"),
  v.literal("deleting"),
);

export const gitConnectionStatus = v.union(
  v.literal("ready"),
  v.literal("reauthorization-required"),
  v.literal("revoked"),
);
