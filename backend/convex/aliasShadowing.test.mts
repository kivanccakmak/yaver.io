// aliasShadowing.test.mts — pins the device-row shadowing rule.
// Run: node --experimental-strip-types --test convex/aliasShadowing.test.mts

import test from "node:test";
import assert from "node:assert/strict";

import { aliasCollisionOutcome } from "./aliasShadowing.ts";

test("no strong conflict → merge (same machine seen twice)", () => {
  assert.equal(
    aliasCollisionOutcome(
      { hardwareId: "hw1", online: true, needsAuth: false },
      { hardwareId: "hw1", online: false, needsAuth: true },
    ),
    "merge",
  );
  // Missing identity on one side is NOT a conflict.
  assert.equal(
    aliasCollisionOutcome(
      { hardwareId: "hw1", online: true, needsAuth: false },
      { online: true, needsAuth: false },
    ),
    "merge",
  );
});

test("strong conflict, one dead → keep the live one", () => {
  assert.equal(
    aliasCollisionOutcome(
      { hardwareId: "hw1", online: true, needsAuth: false },
      { hardwareId: "hw2", online: false, needsAuth: true },
    ),
    "keep-a",
  );
  assert.equal(
    aliasCollisionOutcome(
      { hardwareId: "hw1", online: false, needsAuth: true },
      { hardwareId: "hw2", online: true, needsAuth: false },
    ),
    "keep-b",
  );
});

test("THE REGRESSION: strong conflict, both healthy → keep BOTH, never merge", () => {
  // Two different machines behind one hostname (real agent + service cell).
  // Merging them makes deviceId/name flip on every heartbeat — the picker
  // flip-flop this file exists to prevent.
  assert.equal(
    aliasCollisionOutcome(
      { hardwareId: "hw-agent", online: true, needsAuth: false },
      { hardwareId: "hw-simcell", online: true, needsAuth: false },
    ),
    "keep-both",
  );
  // Different publicKey alone is also a strong conflict.
  assert.equal(
    aliasCollisionOutcome(
      { publicKey: "pk1", online: true, needsAuth: false },
      { publicKey: "pk2", online: true, needsAuth: false },
    ),
    "keep-both",
  );
  // Both dead is still ambiguous — keep both rather than invent a winner.
  assert.equal(
    aliasCollisionOutcome(
      { hardwareId: "hw1", online: false, needsAuth: true },
      { hardwareId: "hw2", online: false, needsAuth: true },
    ),
    "keep-both",
  );
});
