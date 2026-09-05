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
import { fileURLToPath } from "node:url";
import path from "node:path";
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
  // `import.meta.url` is already a file:// string; converting it straight to
  // a path avoids the DOM-URL vs node:url.URL lib clash entirely (their
  // searchParams iterator types differ) — exactly the kind of phantom drift
  // this drift-test shouldn't be failing on.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const strip = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
      .replace(/^\s*\/\/.*$/gm, "")        // line comments
      .replace(/\s+/g, " ")
      .trim();
  const mine = strip(readFileSync(path.join(here, "connectionFanout.ts"), "utf8"));
  const theirs = strip(readFileSync(path.join(here, "../../../web/lib/connectionFanout.ts"), "utf8"));
  assert.equal(mine, theirs, "web and mobile connectionFanout have drifted apart");
});

// STRUCTURE — the phone's pool-warm pass must use the shared plan, and must
// keep the health filter that stopped the reconnect storm.
test("mobile warms its pool from the shared plan, with the health filter intact", () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../context/DeviceContext.tsx"), "utf8");
  assert.match(src, /planConnectionFanout\(\{/, "the warm pass must build a plan");
  assert.match(src, /mode: connectionMode/, "the user preference must reach the warm pass");
  // The filter is what prevents warming machines with stale LAN/Tailscale
  // addresses — the documented cause of the storm. The plan picks WHO is worth
  // pooling; this picks who is in a state to be pooled at all.
  assert.match(src, /d\.online &&\s*!d\.needsAuth/, "the health filter was removed — the reconnect storm returns");
  assert.match(src, /!unreachableSet\.has\(d\.id\)/, "unreachable machines are being warmed again");
  assert.match(
    src,
    /const probe = await probeMobileDeviceStatus\(device,[\s\S]{0,240}if \(!probe\.reachable\) \{[\s\S]{0,180}connectionManager\.disconnect\(device\.id\)/,
    "background warm must prove the operation and tear down a false-online client",
  );
  assert.match(
    src,
    /catch \{[\s\S]{0,500}connectionManager\.disconnect\(device\.id\);[\s\S]{0,120}markDeviceUnreachable\(device\.id\)/,
    "a failed advisory warm must not leave an indefinite reconnect ladder",
  );
  assert.match(src, /warmProbeInFlightRef\.current\.has\(device\.id\)/, "reactive rerenders must not duplicate a warm probe");
  assert.match(src, /warmProbeInFlightRef\.current\.delete\(device\.id\)/, "a completed warm probe must release its dedupe slot");
});
