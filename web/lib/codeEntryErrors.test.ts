/**
 * codeEntryErrors.test.ts — `npx tsx lib/codeEntryErrors.test.ts`.
 *
 * Every wrong-code path in Yaver reported a 500.
 *
 * The sentinels are thrown inside Convex mutations (`throw new Error(
 * "INVALID_CODE")` in deviceCode.ts and totp.ts) and read back in an
 * httpAction — after crossing a Convex boundary that DECORATES the message.
 * What arrives is not "INVALID_CODE" but a wrapped Server Error carrying a
 * request id and a stack. Five `e.message === "INVALID_CODE"` comparisons were
 * therefore always false, and every one of them fell through to its catch-all.
 *
 * Measured against prod 2026-08-01, signed in, with a mistyped code:
 *
 *     POST /api/auth/device/authorize  →  500 {"error":"Failed to authorize"}
 *
 * A server error for a typo, on the path an unreachable box is rescued through.
 * Both ends already had the right answer — the backend mapped four sentinels to
 * 404/410/409/429 and DeviceCodeClient.tsx rendered a distinct sentence for each
 * — and neither could ever run. It also hit TOTP enable, disable, and 2FA login,
 * so a wrong 2FA code said "server error" too.
 *
 * This pins the fix from both sides: the decoded shape, and the structure that
 * lets it decode. Prove it by breaking it — put one `===` back and rerun.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const httpTs = readFileSync(join(root, "backend/convex/http.ts"), "utf8");
/** Comments quote the anti-pattern on purpose (including the one explaining
 *  this bug), so the structural scan below reads code only. */
const httpCode = httpTs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const clientTsx = readFileSync(join(root, "web/app/auth/device/DeviceCodeClient.tsx"), "utf8");

/** The exact shape Convex hands an httpAction. Copied from a real failure so
 *  the test breaks if the decoration changes rather than passing on a guess. */
const wrapped = (sentinel: string) =>
  `[CONVEX M(deviceCode:authorizeDeviceCode)] [Request ID: 8f2a1c] Server Error\n` +
  `Uncaught Error: ${sentinel}\n    at handler (../convex/deviceCode.ts:319:13)`;

// Mirrors thrownSentinel() in backend/convex/http.ts.
const SENTINELS = [
  "INVALID_CODE", "CODE_EXPIRED", "CODE_ALREADY_USED",
  "TOO_MANY_ATTEMPTS", "INVALID_PENDING", "PENDING_EXPIRED",
  // The same drift hit account linking and every bare "Unauthorized" throw, so
  // a bad link token answered 400-with-a-stack instead of 410, and a mutation
  // that rejected an unauthenticated caller lost its 401.
  "INVALID_LINK_TOKEN", "TARGET_USER_NOT_FOUND", "IDENTITY_ALREADY_LINKED",
  "Unauthorized",
];
const decode = (raw: string) => SENTINELS.find((s) => raw.includes(s)) ?? null;

test("decodes a sentinel after it crosses the Convex boundary", () => {
  for (const s of SENTINELS) {
    assert.equal(decode(wrapped(s)), s, `${s} is unreadable once wrapped — this is the original bug`);
    // Still correct for the bare form, so the fix survives a Convex release
    // that stops decorating rather than silently reverting to 500s.
    assert.equal(decode(s), s);
  }
});

test("does not invent a sentinel for an unrelated failure", () => {
  assert.equal(decode("[CONVEX M(x)] Server Error\nUncaught TypeError: y is not a function"), null);
  assert.equal(decode(""), null);
});

test("equality against a sentinel can never work — the shape this test exists for", () => {
  assert.notEqual(wrapped("INVALID_CODE"), "INVALID_CODE");
});

test("no catch block compares a raw .message with a sentinel", () => {
  // Precisely the anti-pattern: equality against the RAW message. Comparing the
  // already-decoded result of thrownSentinel() with === is correct and must not
  // trip this, or the guard punishes the fix.
  const offenders = SENTINELS.flatMap((s) =>
    [...httpCode.matchAll(new RegExp(`\\.message\\s*===\\s*"${s}"`, "g"))].map(() => s),
  );
  assert.deepEqual(offenders, [],
    `backend/convex/http.ts compares ${offenders.join(", ")} with === again — ` +
    `that comparison is false after the Convex boundary, so those codes are back to 500`);
});

test("the backend sends a machine-readable code beside the sentence", () => {
  assert.ok(httpTs.includes("function sentinelCode("),
    "sentinelCode() is gone — surfaces are back to keying off HTTP status or prose");
  assert.match(httpTs, /errorResponse\((?:.|\n)*?sentinelCode\(s\)\)/,
    "no errorResponse carries a code — the stable signal is not on the wire");
});

test("the approver keys off that code, not just the status", () => {
  assert.ok(clientTsx.includes('code === "invalid_code"'),
    "DeviceCodeClient no longer reads data.code — a status drift re-silences every wrong code");
  assert.ok(clientTsx.includes('code === "too_many_attempts"') || clientTsx.includes("res.status === 429"),
    "rate-limited attempts fall into the catch-all again");
});

test("a click with no session says so instead of doing nothing", () => {
  const i = clientTsx.indexOf("const handleSubmit");
  assert.ok(i > 0, "handleSubmit is gone — re-point this test at whatever replaced it");
  const body = clientTsx.slice(i, i + 700);
  assert.ok(!/if \(!token\) return;/.test(body),
    "handleSubmit returns silently with no token — the Authorize button does literally nothing, " +
    "and the user cannot tell a dead click from a slow network");
});

test("a login form never echoes a decorated Convex stack back to the user", () => {
  assert.ok(!httpTs.includes('errorResponse(e.message || "Failed to enable TOTP"'),
    "TOTP enable echoes e.message — that is a Convex stack trace with file paths and a request id");
  assert.ok(!httpTs.includes('errorResponse(e.message || "Verification failed"'),
    "2FA login echoes e.message — same leak, on the login path");
});

test("a pinned agent version is refused at request time, not consumed and lost", () => {
  // claimAndApplyAgentUpdateRequest installs only `latest`; anything else it
  // logs and drops — AFTER the claim has already cleared desiredAgentVersion.
  // So a pinned request used to be acknowledged with {ok:true} and then vanish.
  // Measured 2026-08-01: six machines queued for 1.99.395, all acknowledged,
  // all silently unchanged 12 minutes later; re-queued as "latest" and three
  // updated within four minutes.
  assert.ok(httpCode.includes("pinned_version_unsupported"),
    "/devices/request-update no longer rejects a pinned version — it is back to " +
    "accepting a request the agent will silently discard, on the one lever that " +
    "works when a box cannot be reached by anything else");
  assert.match(httpCode, /can only update to "latest"/,
    "the refusal no longer names the remedy");
});

test("auth-dependent JSON responses declare Vary: Authorization", () => {
  // GET /config returns the same URL to everyone and a DIFFERENT body: anonymous
  // callers get the public relay list, signed-in callers get it with their
  // per-user relay password attached. Without Vary, a cache may serve the
  // anonymous copy to an authenticated request — and did.
  //
  // Measured 2026-08-01: /config with a bearer token returned relay servers with
  // NO password, byte-identical to anonymous; the same fetch with
  // cache:"no-store" returned a 48-char password. Downstream that surfaced as
  // 401 relay_password_missing on every relay dial, a dashboard reading "Relay
  // refused: account relay password missing or stale", and a remedy of "sign in
  // again" that cannot work — signing in re-fetches the same cached response.
  const i = httpCode.indexOf("function jsonResponse(");
  assert.ok(i > 0, "jsonResponse is gone — re-point this test at whatever replaced it");
  const body = httpCode.slice(i, i + 600);
  assert.match(body, /Vary:\s*"Authorization"/,
    "jsonResponse no longer sets Vary: Authorization — an anonymous /config response " +
    "can be cached and served to signed-in callers, stripping their relay password");
});
