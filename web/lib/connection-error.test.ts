/**
 * connection-error.test.ts — `npx tsx lib/connection-error.test.ts`
 *
 * Pins the FALSE-POSITIVE "Unauthorized" fix (2026-07-28,
 * docs/architecture/CLOSED_LOOP_FALSE_POSITIVE_TESTING.md). The device card
 * showed "Alive · can't reach (Unauthorized)" on a box whose agent answered
 * /health 200 over the relay — because the reachability probe recorded a bare
 * "HTTP 401" and THREW AWAY the relay's response body. With the body dropped,
 * classifyFetchError could not see the self-healable relay-credential message
 * and fell through to the agent-blaming "Unauthorized".
 *
 * The fix (DevicesView probes now capture `await res.text()`) is only correct
 * if the classifier does the right thing WITH the body — that's what this pins,
 * including the negative control that reproduces the old false positive.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { classifyFetchError } from "./connection-error";

// The relay's REAL 401 body, verified live against public.yaver.io 2026-07-28:
//   {"error":"invalid relay password"}
const RELAY_401_BODY = 'HTTP 401: {"error":"invalid relay password"}';

test("relay 401 carrying the relay body → relay-credential (self-healable), NOT agent-Unauthorized", () => {
  const c = classifyFetchError({
    error: new Error(RELAY_401_BODY),
    response: { status: 401 },
    path: "relay",
  });
  assert.equal(c.reason, "relay-credential", `expected relay-credential, got ${c.reason} (${c.label})`);
  assert.notEqual(c.label, "Unauthorized", "must not blame the agent for our stale relay password");
});

test("NEGATIVE CONTROL: bare 'HTTP 401' with the body dropped → the OLD false 'Unauthorized'", () => {
  // This is exactly the pre-fix behaviour. It proves the body-capture matters:
  // without the body, the classifier cannot tell relay-credential from a real
  // agent 401 and produces the scary, agent-blaming label on a healthy box.
  const c = classifyFetchError({
    error: new Error("HTTP 401"),
    response: { status: 401 },
    path: "relay",
  });
  assert.equal(c.reason, "unauthorized", "bare HTTP 401 reproduces the false positive (why we capture the body)");
});

test("a GENUINE agent 401 over a working relay lane keeps the agent copy (no over-correction)", () => {
  const c = classifyFetchError({
    error: new Error('HTTP 401: {"error":"invalid token"}'),
    response: { status: 401 },
    path: "relay",
  });
  assert.equal(c.reason, "unauthorized", "an agent token rejection must NOT be mislabeled relay-credential");
});

test("relay-credential label is honest + actionable (names the real cause, suggests re-sign-in)", () => {
  const c = classifyFetchError({
    error: new Error(RELAY_401_BODY),
    response: { status: 401 },
    path: "relay",
  });
  assert.match(c.label.toLowerCase(), /relay/, "label should name the relay, not the agent");
  assert.ok(c.suggestedAction && /sign in/i.test(c.suggestedAction), "should route the user to the fix");
});
