/**
 * connectionFanout.test.ts — `npx tsx lib/connectionFanout.test.ts`
 *
 * Pins the 2026-08-01 decisions: fan out by default, honour the Convex-seeded
 * primary/secondary as ORDER, never silently drop a machine, and never let a
 * metered account pay for a policy it did not choose.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  planConnectionFanout,
  resolveSeededRole,
  METERED_FANOUT_LIMIT,
  fanoutModeFromSettings,
  type FanoutCandidate,
} from "./connectionFanout.ts";

const devices: FanoutCandidate[] = [
  { deviceId: "ubuntu", isOnline: true },
  { deviceId: "magara", isOnline: true },
  { deviceId: "mac", isOnline: true },
  { deviceId: "ofis2", isOnline: true },
  { deviceId: "mini", isOnline: false },
  { deviceId: "vostro", isOnline: false },
];

const seed = {
  runnerDeviceId: "ubuntu",
  secondaryRunnerDeviceId: "ofis2",
  renderDeviceId: "magara",
  secondaryRenderDeviceId: "mac",
};

test("default is fan-out: an owner connects to every machine", () => {
  const plan = planConnectionFanout({ devices, seed, isOwner: true });
  assert.equal(plan.mode, "all");
  assert.equal(plan.targets.length, devices.length, "owner is unmetered — no machine withheld");
  assert.deepEqual(plan.deferred, [], "nothing deferred for an unmetered account");
});

test("the seeded roles are the ORDER, not a badge", () => {
  const plan = planConnectionFanout({ devices, seed, isOwner: true });
  assert.deepEqual(
    plan.targets.slice(0, 4).map((t) => [t.deviceId, t.role]),
    [
      ["ubuntu", "primary-runner"],
      ["magara", "primary-render"],
      ["ofis2", "secondary-runner"],
      ["mac", "secondary-render"],
    ],
  );
});

test("a metered account is bounded, and says exactly what it withheld", () => {
  const plan = planConnectionFanout({ devices, seed, isOwner: false });
  assert.equal(plan.targets.length, METERED_FANOUT_LIMIT);
  assert.equal(plan.deferred.length, devices.length - METERED_FANOUT_LIMIT);
  for (const d of plan.deferred) {
    assert.match(d.reason, /metered/, "a dropped machine must carry its reason");
  }
  // The bound must keep the machines the account's own roles name.
  const kept = plan.targets.map((t) => t.deviceId);
  for (const id of ["ubuntu", "magara", "ofis2", "mac"]) assert.ok(kept.includes(id), id);
});

test("single mode is a real downgrade, and is never the default", () => {
  const plan = planConnectionFanout({ devices, seed, mode: "single", isOwner: true });
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0].deviceId, "ubuntu", "the seeded primary runner leads");
  assert.equal(plan.deferred.length, devices.length - 1);
  assert.match(plan.deferred[0].reason, /single-connection mode/);
  // And the default really is "all".
  assert.equal(planConnectionFanout({ devices, seed, isOwner: true }).mode, "all");
});

test("a seed naming an unknown device is skipped, not invented", () => {
  const plan = planConnectionFanout({
    devices: [{ deviceId: "ubuntu" }],
    seed: { runnerDeviceId: "ghost", renderDeviceId: "ubuntu" },
    isOwner: true,
  });
  assert.deepEqual(plan.targets.map((t) => t.deviceId), ["ubuntu"]);
});

test("no device appears twice when one machine holds several roles", () => {
  const plan = planConnectionFanout({
    devices: [{ deviceId: "solo" }],
    seed: { runnerDeviceId: "solo", renderDeviceId: "solo", secondaryRenderDeviceId: "solo" },
    isOwner: true,
  });
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0].role, "primary-runner");
});

// --- role resolution: the magara bug -----------------------------------------

test("render falls back to the seeded SECONDARY before anything else", () => {
  const reachable = (id: string) => id !== "magara"; // primary render unreachable
  const got = resolveSeededRole("render", seed, reachable);
  assert.equal(got.deviceId, "mac", "must use the seeded secondary render");
  assert.equal(got.role, "secondary-render");
  assert.equal(got.degraded, true, "a fallback must announce itself");
});

test("a healthy primary is never bypassed", () => {
  const got = resolveSeededRole("render", seed, () => true);
  assert.equal(got.deviceId, "magara");
  assert.equal(got.degraded, false);
});

test("with nothing reachable it still names the machine the account chose", () => {
  const got = resolveSeededRole("render", seed, () => false);
  assert.equal(got.deviceId, "magara", "never drift silently to some other box");
  assert.equal(got.degraded, false);
});

test("a render role with no render seed uses the runner box, undegraded", () => {
  const got = resolveSeededRole("render", { runnerDeviceId: "ubuntu" }, () => true);
  assert.equal(got.deviceId, "ubuntu");
  assert.equal(got.degraded, false, "single-machine setups are not a degradation");
});

test("runner resolution honours its own secondary", () => {
  assert.equal(resolveSeededRole("runner", seed, (id) => id !== "ubuntu").deviceId, "ofis2");
});

// STRUCTURE — a signal with no consumer is not shipped. Vibing is the surface
// that picked a renderer the account never nominated, so it must be the one
// resolving through the seeded roles.
test("Vibing resolves its render machine through the seeded roles", () => {
  const src = readFileSync(new URL("../components/dashboard/RuntimeLabView.tsx", import.meta.url), "utf8");
  assert.match(src, /resolveSeededRole\(\s*"render"/, "Vibing must call resolveSeededRole for the render box");
  // Scoped to the RESOLUTION site. The editor's draft pre-fill legitimately
  // reads renderDeviceId || runnerDeviceId — it is showing what is configured,
  // not deciding which box serves.
  const resolution = src.slice(src.indexOf("const effectiveRenderDeviceId"), src.indexOf("const effectiveRenderBoxName"));
  assert.ok(
    !/machineRoles\?\.renderDeviceId/.test(resolution),
    "the resolution site is reading the raw seed again instead of resolveSeededRole",
  );
  assert.match(resolution, /seededRender\.deviceId/, "it must use the resolved role");
});

// --- the user preference ------------------------------------------------------
test("fan-out is the default for anything that is not an explicit downgrade", () => {
  for (const settings of [null, undefined, {}, { connectionMode: "all" }, { connectionMode: "" }, { connectionMode: "nonsense" }, { connectionMode: 3 }]) {
    assert.equal(fanoutModeFromSettings(settings as never), "all", JSON.stringify(settings));
  }
});

test("only the explicit value downgrades", () => {
  assert.equal(fanoutModeFromSettings({ connectionMode: "single" }), "single");
});

test("the preference actually governs the plan", () => {
  const settings = { connectionMode: "single" };
  const plan = planConnectionFanout({ devices, seed, mode: fanoutModeFromSettings(settings), isOwner: true });
  assert.equal(plan.targets.length, 1);
  assert.ok(plan.deferred.length > 0, "a downgrade must still report what it withheld");
});
