/**
 * connectionFanout.test.ts — `npx tsx src/lib/connectionFanout.test.ts`
 *
 * The RN twin of web/lib/connectionFanout.test.ts. Its job is drift: Metro and
 * Next resolve two independent copies, so a change made on one side is
 * invisible to the other's typechecker and shows up as two surfaces disagreeing
 * about which machine should serve — exactly the class of bug the seeded-role
 * work exists to remove.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { planConnectionFanout, resolveSeededRole, METERED_FANOUT_LIMIT } from "./connectionFanout";

const devices = [
  { deviceId: "ubuntu", isOnline: true },
  { deviceId: "magara", isOnline: true },
  { deviceId: "mac", isOnline: true },
  { deviceId: "ofis2", isOnline: true },
  { deviceId: "mini", isOnline: false },
];
const seed = {
  runnerDeviceId: "ubuntu",
  secondaryRunnerDeviceId: "ofis2",
  renderDeviceId: "magara",
  secondaryRenderDeviceId: "mac",
};

test("the phone fans out by default, like every other surface", () => {
  const plan = planConnectionFanout({ devices, seed, isOwner: true });
  assert.equal(plan.mode, "all");
  assert.equal(plan.targets.length, devices.length);
});

test("seeded roles order the phone's connections too", () => {
  const plan = planConnectionFanout({ devices, seed, isOwner: true });
  assert.deepEqual(plan.targets.slice(0, 2).map((t) => t.deviceId), ["ubuntu", "magara"]);
});

test("a metered account is bounded on the phone as well", () => {
  const plan = planConnectionFanout({ devices, seed, isOwner: false });
  assert.equal(plan.targets.length, METERED_FANOUT_LIMIT);
  assert.ok(plan.deferred.every((d) => /metered/.test(d.reason)));
});

test("render demotes to the seeded secondary when the primary is unreachable", () => {
  const got = resolveSeededRole("render", seed, (id) => id !== "magara");
  assert.equal(got.deviceId, "mac");
  assert.equal(got.degraded, true);
});

// PARITY — the two copies must not drift. Comments may differ; logic may not.
test("the mobile twin matches web, logic for logic", () => {
  const here = new URL(".", import.meta.url);
  const strip = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
      .replace(/^\s*\/\/.*$/gm, "")        // line comments
      .replace(/\s+/g, " ")
      .trim();
  const mine = strip(readFileSync(new URL("connectionFanout.ts", here), "utf8"));
  const theirs = strip(readFileSync(new URL("../../../web/lib/connectionFanout.ts", here), "utf8"));
  assert.equal(mine, theirs, "web and mobile connectionFanout have drifted apart");
});
