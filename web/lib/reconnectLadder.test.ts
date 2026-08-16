/**
 * reconnectLadder.test.ts — `npx tsx lib/reconnectLadder.test.ts`.
 *
 * Pins the web reconnect ladder policy (audit gap T2): repair rung once per
 * streak, topology rung every 3rd attempt, terminal stop on device_mismatch,
 * and a NAMED give-up instead of the old silent stop at the cap.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { planReconnect } from "./reconnectLadder";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("relay-auth cause fires the repair rung exactly once per streak", () => {
  const first = planReconnect({ attempt: 1, maxAttempts: 8, lastCause: "invalid relay password (reason=bad_password)", repairAttemptedThisStreak: false });
  assert.equal(first.action, "retry");
  assert.equal((first as any).repairRelay, true);

  const second = planReconnect({ attempt: 2, maxAttempts: 8, lastCause: "invalid relay password (reason=bad_password)", repairAttemptedThisStreak: true });
  assert.equal((second as any).repairRelay, false);
});

test("non-auth causes never fire the repair rung", () => {
  const plan = planReconnect({ attempt: 1, maxAttempts: 8, lastCause: "device not connected to relay", repairAttemptedThisStreak: false });
  assert.equal(plan.action, "retry");
  assert.equal((plan as any).repairRelay, false);
});

test("topology rung fires every 3rd attempt", () => {
  for (const [attempt, expect] of [[1, false], [2, false], [3, true], [4, false], [6, true]] as const) {
    const plan = planReconnect({ attempt, maxAttempts: 8, lastCause: "timeout", repairAttemptedThisStreak: false });
    assert.equal(plan.action, "retry");
    assert.equal((plan as any).refreshTopology, expect, `attempt ${attempt}`);
  }
});

test("device_mismatch stops the ladder immediately with the named remedy", () => {
  const plan = planReconnect({
    attempt: 1,
    maxAttempts: 8,
    lastCause: "relay password owner does not own this deviceId (reason=device_mismatch)",
    repairAttemptedThisStreak: false,
  });
  assert.equal(plan.action, "stop-terminal");
  assert.match((plan as any).message, /different Yaver account/);
  assert.match((plan as any).message, /yaver auth/);
});

test("give-up is NAMED and carries the last cause", () => {
  const plan = planReconnect({ attempt: 8, maxAttempts: 8, lastCause: "HTTP 502", repairAttemptedThisStreak: true });
  assert.equal(plan.action, "give-up");
  assert.match((plan as any).message, /8 attempts/);
  assert.match((plan as any).message, /HTTP 502/);
  assert.match((plan as any).message, /Reconnect/);
});

test("AgentClient.scheduleReconnect consumes the plan (no dead seam)", () => {
  const src = readFileSync(join(webRoot, "lib/agent-client.ts"), "utf8");
  assert.match(src, /from "\.\/reconnectLadder"/);
  assert.match(src, /planReconnect\(/);
  assert.match(src, /repairRelayPassword\(\)/);
});
