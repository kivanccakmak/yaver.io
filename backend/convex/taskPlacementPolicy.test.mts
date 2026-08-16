import test from "node:test";
import assert from "node:assert/strict";

// Pure owned-device placement policy — real-path import per
// scripts/test-suite.sh policy-test rule (taskPlacement.ts imports Convex
// internals; the decision lives in taskPlacementPolicy.ts).
import { selectLiveOwnedDevice, PLACEMENT_HEARTBEAT_STALE_MS } from "./taskPlacementPolicy.ts";

const NOW = 1_800_000_000_000;

function device(over: Record<string, unknown> = {}) {
  return {
    deviceId: "d-1",
    isOnline: true,
    lastHeartbeat: NOW,
    needsAuth: false,
    installedRunnerIds: ["opencode"],
    publishCapabilities: [],
    ...over,
  };
}

// THE INCIDENT (2026-08-10, medici task on ubuntu-4gb-hel1-1): the primary
// self-hosted box's row carried needsAuth=true from a relay-password flap.
// The OLD filter (isOnline && !needsAuth) excluded it, the owned pool came
// back EMPTY, and placement fell through to cloud_standard on an ASLEEP
// managed box — task parked queued with attempts=0 forever while the healthy
// box sat idle. LIVE must mean heartbeat-fresh, not flag-true.
test("needsAuth box with a FRESH heartbeat is still a live placement candidate", () => {
  const hit = selectLiveOwnedDevice(
    [device({ deviceId: "ubuntu", needsAuth: true })],
    { now: NOW, needsBuild: false, primaryDeviceId: "ubuntu" },
  );
  assert.ok(hit, "a heartbeat-fresh box must win even when needsAuth=true (re-auth is recoverable; an asleep cloud box is not)");
  assert.equal(hit!.deviceId, "ubuntu");
});

test("stale heartbeat (isOnline true but old) is NOT a candidate", () => {
  const hit = selectLiveOwnedDevice(
    [device({ deviceId: "ubuntu", lastHeartbeat: NOW - PLACEMENT_HEARTBEAT_STALE_MS - 1000 })],
    { now: NOW, needsBuild: false, primaryDeviceId: "ubuntu" },
  );
  assert.equal(hit, null, "a box whose heartbeat is stale is not live, period");
});

test("isOnline=false is never a candidate even with fresh heartbeat", () => {
  const hit = selectLiveOwnedDevice(
    [device({ deviceId: "ubuntu", isOnline: false })],
    { now: NOW, needsBuild: false, primaryDeviceId: "ubuntu" },
  );
  assert.equal(hit, null);
});

test("primary is preferred over a non-primary when both are live", () => {
  const hit = selectLiveOwnedDevice(
    [device({ deviceId: "other" }), device({ deviceId: "primary" })],
    { now: NOW, needsBuild: false, primaryDeviceId: "primary" },
  );
  assert.equal(hit!.deviceId, "primary");
});

test("runner not installed on the primary defers to a live box that has it", () => {
  const hit = selectLiveOwnedDevice(
    [
      device({ deviceId: "primary", installedRunnerIds: ["claude"] }),
      device({ deviceId: "ubuntu", installedRunnerIds: ["opencode"] }),
    ],
    { now: NOW, needsBuild: false, runnerId: "opencode", primaryDeviceId: "primary" },
  );
  assert.equal(hit!.deviceId, "ubuntu", "a box without the requested runner must not win over one that has it");
});

test("needsBuild requires publish capability", () => {
  const hit = selectLiveOwnedDevice(
    [device({ deviceId: "ubuntu", publishCapabilities: [] })],
    { now: NOW, needsBuild: true, primaryDeviceId: "ubuntu" },
  );
  assert.equal(hit, null, "a box that cannot publish must not be chosen for a build/deploy");
  const withCap = selectLiveOwnedDevice(
    [device({ deviceId: "ubuntu", publishCapabilities: ["testflight"] })],
    { now: NOW, needsBuild: true, primaryDeviceId: "ubuntu" },
  );
  assert.equal(withCap!.deviceId, "ubuntu");
});

test("explicit targetDeviceId wins when it is live", () => {
  const hit = selectLiveOwnedDevice(
    [device({ deviceId: "a" }), device({ deviceId: "b" })],
    { now: NOW, needsBuild: false, targetDeviceId: "b", primaryDeviceId: "a" },
  );
  assert.equal(hit!.deviceId, "b", "an explicit target overrides primary order");
});

test("empty device list yields null (placement may fall to cloud) — the safe fallback", () => {
  assert.equal(selectLiveOwnedDevice([], { now: NOW, needsBuild: false }), null);
});
