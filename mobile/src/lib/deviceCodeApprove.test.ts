/**
 * deviceCodeApprove.test.ts — `npx tsx src/lib/deviceCodeApprove.test.ts`.
 *
 * The phone is the surface the device-code rescue was designed around: a box
 * whose session is dead self-nominates a code, and a phone that is ALREADY
 * signed in approves it with one tap — no browser, no typing on the box.
 *
 * Two defects sat on that tap until 2026-08-01.
 *
 * 1. It rendered the RAW response body. `res.text()` went straight into the
 *    error string, so the user was shown a JSON blob — and because the backend
 *    sentinels never survived the Convex boundary, that blob read
 *    `{"error":"Failed to authorize"}` for a simple typo. A server error, as
 *    JSON, for a mistyped code.
 * 2. Neither fetch was bounded. RN's `fetch` has no default timeout, so the
 *    Approve button could spin forever with no cause — the same shape that
 *    pinned the connect pill at "Connecting" for 30+ minutes.
 *
 * Prove either guard by breaking it: return `body` verbatim from
 * approveFailureMessage, or drop the AbortController, and rerun.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { approveFailureMessage } from "./approveFailureMessage";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "deviceCodeApprove.ts"), "utf8");

const body = (code: string, error = "server sentence") => JSON.stringify({ error, code });

test("names each failure from the stable code", () => {
  assert.match(approveFailureMessage(404, body("invalid_code")), /invalid code/i);
  assert.match(approveFailureMessage(410, body("code_expired")), /expired/i);
  assert.match(approveFailureMessage(409, body("code_already_used")), /already been used/i);
  assert.match(approveFailureMessage(429, body("too_many_attempts")), /too many attempts/i);
});

test("the code wins over a drifted status", () => {
  // The whole point of shipping a machine-readable code: if the status ever
  // moves again, the sentence must not.
  assert.match(approveFailureMessage(500, body("invalid_code")), /invalid code/i);
  assert.match(approveFailureMessage(400, body("code_expired")), /expired/i);
});

test("falls back to the status when no code is sent", () => {
  // Older deployments, and any handler that has not been given a code yet.
  assert.match(approveFailureMessage(404, '{"error":"nope"}'), /invalid code/i);
  assert.match(approveFailureMessage(410, ""), /expired/i);
  assert.match(approveFailureMessage(401, ""), /not signed in/i);
});

test("never renders the raw body to the user — the original defect", () => {
  const raw = '{"error":"Failed to authorize"}';
  const shown = approveFailureMessage(500, raw);
  assert.ok(!shown.includes("{"), `a JSON blob reached the user: ${shown}`);
  assert.ok(!shown.includes("Failed to authorize"),
    "the backend catch-all sentence is being echoed verbatim");
  assert.match(shown, /try again/i, "an unclassified failure must still say what to do");
});

test("an unparseable body does not throw", () => {
  assert.match(approveFailureMessage(503, "<html>502 Bad Gateway</html>"), /could not approve/i);
});

test("both fetches are wall-clock bounded", () => {
  assert.ok(source.includes("new AbortController()"),
    "no AbortController — RN fetch has no default timeout, so Approve can hang forever");
  assert.ok(!/await fetch\(/.test(source.replace(/return await fetch\(url, \{[\s\S]*?\}\);/, "")),
    "a bare `await fetch(` is back on the rescue path — route it through boundedFetch");
  assert.match(source, /APPROVE_TIMEOUT_MS\s*=\s*\d/, "the deadline is not a named constant");
});

test("an abort is named, not reported as a mystery", () => {
  assert.ok(source.includes('err?.name === "AbortError"'),
    "a timeout falls into the generic catch — the user cannot tell slow from broken");
});

test("says the same thing the web approver says", () => {
  // A user who tries the phone and then the browser must not be told two
  // different stories about one code. web/app/auth/device/DeviceCodeClient.tsx
  // is the twin; these are the phrases it renders.
  const web = readFileSync(join(here, "../../../web/app/auth/device/DeviceCodeClient.tsx"), "utf8");
  for (const phrase of ["Invalid code.", "has already been used", "Too many attempts"]) {
    assert.ok(web.includes(phrase), `web approver no longer says "${phrase}" — the surfaces have drifted`);
  }
});
