/**
 * The sentence a user gets when re-auth fails.
 *
 * The fixture is the real string the dashboard shipped on 2026-07-28:
 *   "Re-auth failed: all transports failed. relay · public-free/direct:
 *    device not connected to relay"
 * — lane labels and step names, none of them actionable, and no mention of the
 * fact that made the attempt impossible (a second agent owned the row's id).
 *
 * Run: npx tsx --test web/lib/reauthFailure.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatReauthFailure, reauthFailureLine } from "./reauthFailure";

const RELAY_502 = {
  error: "all transports failed",
  diagnostics: [
    { path: "relay", step: "public-free", ok: false, error: "device not connected to relay" },
    { path: "direct", step: "dial", ok: false, error: "skipped on https" },
  ],
};

test("names the SECOND AGENT, its port and version — never the lane labels", () => {
  const out = formatReauthFailure(RELAY_502, {
    name: "ubuntu-4gb-hel1-1",
    alias: "linux",
    secondaryAgents: [
      { deviceId: "2ed7da41-bd6c", port: 18090, agentVersion: "1.99.259", alias: "linux-3", needsAuth: true, hasTransport: false },
    ],
  });
  assert.equal(out.kind, "relay-presence");
  assert.equal(out.terminal, true);
  assert.match(out.message, /more than one Yaver agent/);
  assert.match(out.message, /@linux-3/);
  assert.match(out.message, /port 18090/);
  assert.match(out.message, /1\.99\.259/);
  assert.match(out.message, /yaver auth/);
  // The lane dump is available, but not in the sentence the user reads.
  assert.doesNotMatch(out.message, /public-free/);
  assert.match(out.technical, /relay\/public-free/);
});

test("specifics are DERIVED from the row, not hardcoded", () => {
  const out = formatReauthFailure(RELAY_502, {
    name: "mac-mini",
    secondaryAgents: [{ deviceId: "abc12345", port: 19999, needsAuth: false, hasTransport: false }],
  });
  assert.match(out.message, /mac-mini/);
  assert.match(out.message, /port 19999/);
  assert.doesNotMatch(out.message, /18090/);
});

test("no second agent → still names the cause and the next step", () => {
  const out = formatReauthFailure(RELAY_502, { name: "some-box" });
  assert.equal(out.kind, "relay-presence");
  assert.equal(out.terminal, true);
  assert.match(out.message, /not connected to the relay/);
  assert.match(out.message, /yaver auth/);
  assert.doesNotMatch(out.message, /all transports failed/);
});

test("the reason code is honoured wherever it arrives", () => {
  // The relay's structured code can land on the top-level error OR inside a
  // per-lane diagnostic depending on which leg gave up first. Both must
  // classify — inventing a regex per channel is how mobile ended up with three.
  const onTop = formatReauthFailure(
    { error: "connectivity.relay.device_not_connected", diagnostics: [] },
    { name: "box" },
  );
  assert.equal(onTop.kind, "relay-presence");
  const inDiag = formatReauthFailure(
    { error: "all transports failed", diagnostics: [{ path: "relay", step: "x", ok: false, error: "relay.device_not_connected" }] },
    { name: "box" },
  );
  assert.equal(inDiag.kind, "relay-presence");
});

test("agent version skew routes to the update, not to the relay story", () => {
  const out = formatReauthFailure(
    { error: "unknown_verb: device_reauth", diagnostics: [] },
    { name: "box" },
  );
  assert.equal(out.kind, "agent-verb-skew");
  assert.match(out.message, /npm install -g yaver-cli@latest/);
});

test("an unclassified failure is passed through, not dressed up", () => {
  const out = formatReauthFailure({ error: "agent refused the bearer", diagnostics: [] }, { name: "box" });
  assert.equal(out.kind, "other");
  assert.equal(out.terminal, false);
  assert.equal(out.message, "Re-auth failed: agent refused the bearer");
});

test("reauthFailureLine is the same sentence (both surfaces render one string)", () => {
  const ctx = { name: "box", secondaryAgents: [] };
  assert.equal(reauthFailureLine(RELAY_502, ctx), formatReauthFailure(RELAY_502, ctx).message);
});
