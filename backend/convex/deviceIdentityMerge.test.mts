// deviceIdentityMerge.test.mts — pins HEALTH-FIRST identity selection.
// Run: node --experimental-strip-types --test convex/deviceIdentityMerge.test.mts
//
// The fixtures are the REAL rows from the 2026-07-28 incident: one physical
// Hetzner box (`ubuntu-4gb-hel1-1`) running two agents that report the same
// hardwareId, so the listing collapse folds them into one row.

import test from "node:test";
import assert from "node:assert/strict";

import {
  pickIdentityOwner,
  resolveIdentityMerge,
  transportEvidenceScore,
  type IdentityCandidate,
  type SecondaryAgentRef,
} from "./deviceIdentityMerge.ts";
import { agentInstanceRelation } from "./aliasShadowing.ts";

const NOW = 1_800_000_000_000;
const HWID = "hw-ubuntu-4gb-hel1-1";

type Row = IdentityCandidate & { secondaryAgents?: SecondaryAgentRef[] };
const toCandidate = (r: Row): IdentityCandidate => r;
const readSecondaries = (r: Row) => r.secondaryAgents;

// The SAME predicate devices.ts injects. If these ever diverge, the identity
// stage and the alias stage stop agreeing about what they are looking at.
const OPTS = { relate: agentInstanceRelation, readSecondaries, now: NOW };

/** The real agent: signed in, port 18080, relay tunnel up, v1.99.389. */
function healthy(overrides: Partial<Row> = {}): Row {
  return {
    deviceId: "5e79cf10-90e8-4a4f-bf07-041061dca210",
    needsAuth: false,
    isOnline: true,
    lastHeartbeat: NOW - 60_000,
    port: 18080,
    agentVersion: "1.99.389",
    alias: "linux",
    hardwareId: HWID,
    publicKey: "pk-agent",
    lastTunnelEvent: { online: true, at: NOW - 30_000 },
    ...overrides,
  };
}

/** The circuit-sim cell: 127.0.0.1:18090, no relay tunnel, needsAuth, v1.99.259. */
function simCell(overrides: Partial<Row> = {}): Row {
  return {
    deviceId: "2ed7da41-bd6c-4dad-8a13-116756a7ed02",
    needsAuth: true,
    isOnline: true,
    lastHeartbeat: NOW - 1_000, // ONE SECOND NEWER than the healthy row
    port: 18090,
    agentVersion: "1.99.259",
    alias: "linux-3",
    hardwareId: HWID,
    publicKey: "pk-simcell",
    lastTunnelEvent: undefined,
    ...overrides,
  };
}

test("THE REGRESSION: a newer heartbeat on the BROKEN agent must not take the identity", () => {
  // Old rule: `(b.lastHeartbeat||0) > (a.lastHeartbeat||0)` — recency beat
  // health, so this exact pair handed the row to the loopback cell and every
  // action routed to a deviceId the relay has no tunnel for.
  const merged = resolveIdentityMerge(healthy(), simCell(), toCandidate, OPTS);
  assert.equal(merged.base.deviceId, "5e79cf10-90e8-4a4f-bf07-041061dca210");
  assert.equal(merged.base.needsAuth, false);
  assert.equal(merged.base.port, 18080);
  assert.equal(merged.base.agentVersion, "1.99.389");
});

test("argument order cannot change the winner (the flip-flop)", () => {
  const ab = resolveIdentityMerge(healthy(), simCell(), toCandidate, OPTS);
  const ba = resolveIdentityMerge(simCell(), healthy(), toCandidate, OPTS);
  assert.equal(ab.base.deviceId, ba.base.deviceId);
  assert.equal(ab.base.needsAuth, ba.base.needsAuth);
});

test("health wins in BOTH directions (the old chain only handled a-broken)", () => {
  assert.equal(pickIdentityOwner(healthy(), simCell(), NOW), "a");
  assert.equal(pickIdentityOwner(simCell(), healthy(), NOW), "b");
});

test("with health equal, a live relay tunnel outranks a bare online flag", () => {
  const tunnelled = healthy({ deviceId: "zzz-later-alphabetically", lastHeartbeat: NOW - 120_000 });
  const bare = healthy({
    deviceId: "aaa-earlier-alphabetically",
    lastHeartbeat: NOW - 1_000,
    lastTunnelEvent: undefined,
  });
  assert.equal(transportEvidenceScore(tunnelled, NOW), 2);
  assert.equal(transportEvidenceScore(bare, NOW), 1);
  assert.equal(pickIdentityOwner(tunnelled, bare, NOW), "a");
  assert.equal(pickIdentityOwner(bare, tunnelled, NOW), "b");
});

test("equal health and transport → deterministic, and never order-dependent", () => {
  const a = healthy({ deviceId: "aaaa", lastHeartbeat: NOW - 5_000 });
  const b = healthy({ deviceId: "bbbb", lastHeartbeat: NOW - 5_000 });
  // Identical heartbeats: deviceId is the total order, so both call orders agree.
  assert.equal(pickIdentityOwner(a, b, NOW), "a");
  assert.equal(pickIdentityOwner(b, a, NOW), "b");
  // Heartbeat still tie-breaks BEFORE deviceId when it differs.
  const newer = healthy({ deviceId: "zzzz", lastHeartbeat: NOW - 1_000 });
  assert.equal(pickIdentityOwner(a, newer, NOW), "b");
});

test("the collapsed-away agent is NAMED, not erased", () => {
  const merged = resolveIdentityMerge(healthy(), simCell(), toCandidate, OPTS);
  assert.equal(merged.secondAgentOnSameBox, true);
  assert.deepEqual(merged.secondaryAgents, [
    {
      deviceId: "2ed7da41-bd6c-4dad-8a13-116756a7ed02",
      port: 18090,
      agentVersion: "1.99.259",
      alias: "linux-3",
      needsAuth: true,
      hasTransport: true, // it heartbeats+online; it just has no relay tunnel
    },
  ]);
});

test("a STALE duplicate row is not reported as a second agent", () => {
  // A leftover row after a re-pair/wipe: same box, different deviceId, but its
  // heartbeat is days old. Naming it as "a second agent on :18090" would just
  // replace the old lie with a fresh one.
  const stale = simCell({ lastHeartbeat: NOW - 5 * 24 * 3600 * 1000, isOnline: false });
  const merged = resolveIdentityMerge(healthy(), stale, toCandidate, OPTS);
  assert.equal(merged.secondAgentOnSameBox, false);
  assert.equal(merged.secondaryAgents, undefined);
  assert.equal(merged.base.deviceId, "5e79cf10-90e8-4a4f-bf07-041061dca210");
});

test("a secondary entry that becomes the row's own identity is dropped", () => {
  const withSelfRef: Row = healthy({
    secondaryAgents: [
      { deviceId: "5e79cf10-90e8-4a4f-bf07-041061dca210", needsAuth: false, hasTransport: true },
      { deviceId: "some-third-agent", port: 18091, needsAuth: true, hasTransport: false },
    ],
  });
  const merged = resolveIdentityMerge(withSelfRef, simCell(), toCandidate, OPTS);
  const ids = (merged.secondaryAgents || []).map((s) => s.deviceId);
  assert.ok(!ids.includes("5e79cf10-90e8-4a4f-bf07-041061dca210"));
  assert.deepEqual(ids, ["2ed7da41-bd6c-4dad-8a13-116756a7ed02", "some-third-agent"]);
});
