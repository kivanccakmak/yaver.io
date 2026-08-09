import test from "node:test";
import assert from "node:assert/strict";

// Pure relay pool policy — real-path import per scripts/test-suite.sh
// policy-test rule (relayPool.ts imports Convex internals, so the pure
// decisions live in relayPoolPolicy.ts).
import {
  relayHostKey,
  selectRelayHostSlot,
  sharedHostDeletionDecision,
  sharedHostGraceSnapshotDecision,
} from "./relayPoolPolicy.ts";

// ── selectRelayHostSlot ─────────────────────────────────────────────────────

test("slot selection first-fits an existing host under capacity", () => {
  const slot = selectRelayHostSlot({ region: "eu", hostCounts: { "relay-eu-0": 3 }, capacity: 20 });
  assert.equal(slot.hostKey, "relay-eu-0");
  assert.equal(slot.needsProvision, false);
  assert.equal(slot.tenantsOnHost, 4);
});

test("slot selection starts a new host when the first is full", () => {
  const slot = selectRelayHostSlot({ region: "eu", hostCounts: { "relay-eu-0": 20 }, capacity: 20 });
  assert.equal(slot.hostKey, "relay-eu-1");
  assert.equal(slot.needsProvision, true);
  assert.equal(slot.tenantsOnHost, 1);
});

test("slot selection is region-isolated", () => {
  const eu = selectRelayHostSlot({ region: "eu", hostCounts: { "relay-us-0": 19 } });
  assert.equal(eu.hostKey, "relay-eu-0");
  const us = selectRelayHostSlot({ region: "us", hostCounts: { "relay-us-0": 19 } });
  assert.equal(us.hostKey, "relay-us-0");
});

test("relayHostKey is stable and human readable", () => {
  assert.equal(relayHostKey("eu", 0), "relay-eu-0");
  assert.equal(relayHostKey("US", 2), "relay-us-2");
});

// ── sharedHostDeletionDecision — never delete a box others still use ────────

test("dedicated relay is always deletable", () => {
  const d = sharedHostDeletionDecision({ sharedHostKey: null, liveTenantsOnHost: 0 });
  assert.equal(d.deleteServer, true);
  const d2 = sharedHostDeletionDecision({ liveTenantsOnHost: 3 });
  assert.equal(d2.deleteServer, true, "absent sharedHostKey means dedicated");
});

test("shared host with other tenants must stay", () => {
  const d = sharedHostDeletionDecision({ sharedHostKey: "relay-eu-0", liveTenantsOnHost: 4 });
  assert.equal(d.deleteServer, false);
  assert.match(d.reason, /tenant/);
});

test("last tenant on a shared host drains and deletes it", () => {
  const d = sharedHostDeletionDecision({ sharedHostKey: "relay-eu-0", liveTenantsOnHost: 0 });
  assert.equal(d.deleteServer, true);
});

// ── sharedHostGraceSnapshotDecision — no billed orphans from pooled hosts ──

test("dedicated relays keep a grace snapshot", () => {
  assert.equal(sharedHostGraceSnapshotDecision(null), true);
  assert.equal(sharedHostGraceSnapshotDecision(undefined), true);
});

test("shared pool hosts never snapshot on teardown (billed-orphan class)", () => {
  assert.equal(sharedHostGraceSnapshotDecision("relay-eu-0"), false);
});
