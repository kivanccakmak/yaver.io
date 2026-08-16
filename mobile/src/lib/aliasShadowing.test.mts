// aliasShadowing.test.mts — pins the device-row shadowing rule.
// Run: node --experimental-strip-types --test src/lib/aliasShadowing.test.mts

import test from "node:test";
import assert from "node:assert/strict";

import { aliasCollisionOutcome, agentInstanceRelation } from "./aliasShadowing.ts";

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

// ---------------------------------------------------------------------------
// 2026-07-28: SAME hardwareId, two running agents. This file was written for
// exactly this box and never fired for it — both rows share a hardwareId, so
// the IDENTITY stage folded them together before the alias stage ran, and the
// old rule would have called them two machines anyway (different publicKey ⇒
// strong conflict ⇒ keep-both) and put ONE machine on screen twice.
// ---------------------------------------------------------------------------

const NOW = 1_800_000_000_000;
const fresh = NOW - 60_000;

test("same box, two live agents (different publicKey/port) → merge-secondary", () => {
  assert.equal(
    agentInstanceRelation(
      { hardwareId: "hw-box", publicKey: "pk-agent", port: 18080, deviceId: "5e79cf10", online: true, needsAuth: false, lastHeartbeat: fresh },
      { hardwareId: "hw-box", publicKey: "pk-simcell", port: 18090, deviceId: "2ed7da41", online: true, needsAuth: true, lastHeartbeat: fresh },
      NOW,
    ),
    "second-agent-same-box",
  );
  assert.equal(
    aliasCollisionOutcome(
      { hardwareId: "hw-box", publicKey: "pk-agent", port: 18080, deviceId: "5e79cf10", online: true, needsAuth: false, lastHeartbeat: fresh },
      { hardwareId: "hw-box", publicKey: "pk-simcell", port: 18090, deviceId: "2ed7da41", online: true, needsAuth: true, lastHeartbeat: fresh },
      NOW,
    ),
    // NOT keep-both: there is one machine. Health picks the identity and the
    // loser becomes a named secondary agent.
    "merge-secondary",
  );
});

test("a publicKey conflict only means TWO MACHINES when no hardwareId ties them", () => {
  // No shared hardwareId → genuinely two machines, unchanged behaviour.
  assert.equal(
    agentInstanceRelation(
      { publicKey: "pk1", online: true, needsAuth: false },
      { publicKey: "pk2", online: true, needsAuth: false },
      NOW,
    ),
    "different-machines",
  );
  // Shared hardwareId → the SAME box running two agents, not two boxes.
  assert.equal(
    agentInstanceRelation(
      { hardwareId: "hw-box", publicKey: "pk1", online: true, needsAuth: false, lastHeartbeat: fresh },
      { hardwareId: "hw-box", publicKey: "pk2", online: true, needsAuth: false, lastHeartbeat: fresh },
      NOW,
    ),
    "second-agent-same-box",
  );
});

test("a STALE sibling row is one agent's history, not a second agent", () => {
  assert.equal(
    agentInstanceRelation(
      { hardwareId: "hw-box", publicKey: "pk-agent", port: 18080, deviceId: "new", online: true, needsAuth: false, lastHeartbeat: fresh },
      { hardwareId: "hw-box", publicKey: "pk-old", port: 18080, deviceId: "old", online: false, needsAuth: true, lastHeartbeat: NOW - 5 * 24 * 3600 * 1000 },
      NOW,
    ),
    "same-agent",
  );
});
