/**
 * relayAuth.test.ts — `npx tsx lib/relayAuth.test.ts`
 *
 * Pins the relay-vs-agent 401 attribution behind the 2026-07-28 incident:
 * a stale web session left the relays without the per-user password, every
 * relay probe 401'd with the RELAY's own body ("relay password missing —
 * sign in again to fetch it"), and the dashboard blamed the AGENT ("Agent
 * responded, but the connection was rejected"). Three layers pinned:
 *
 *  1. the classifier recognises the relay's REAL 401 bodies — read verbatim
 *     from relay/server.go so a relay wording change fails here first;
 *  2. an AGENT 401 body transiting a working relay lane is NOT classified as
 *     a relay credential failure (the agent-rejection copy must survive);
 *  3. structure — the connect-error panel and connection-error classifier
 *     actually consume the shared classifier (a signal with no consumer is
 *     not shipped).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isRelayAuthFailure,
  isRelayCredentialDeny,
  isRelayCredentialDenyCode,
  isRelayCredentialDenyMessage,
  relayDenyCodeFromBody,
  RELAY_DENY_CODES,
} from "./relayAuth";
import { classifyFetchError, summarizeFailures } from "./connection-error";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the relay's REAL 401/429 bodies (read from relay/server.go) all classify as credential denies", () => {
  const relaySrc = readFileSync(join(root, "../relay/server.go"), "utf8");
  const expected = [
    "relay password missing — sign in again to fetch it",
    "invalid relay password",
    "too many invalid relay password attempts",
  ];
  for (const body of expected) {
    assert.ok(
      relaySrc.includes(`"${body}"`),
      `relay/server.go must still emit the exact body ${JSON.stringify(body)} — if this fails, the relay wording changed and the classifier below needs the new string`,
    );
    assert.equal(isRelayCredentialDenyMessage(body), true, body);
  }
  // The client-side prefixed form (relayStatusHint(401) + body).
  assert.equal(
    isRelayCredentialDenyMessage(
      "Relay authentication failed. Check the relay password or sign in again. relay password missing — sign in again to fetch it",
    ),
    true,
  );
  assert.equal(isRelayCredentialDenyMessage("invalid relay password (reason=bad_password)"), true);
});

test("AGENT 401 bodies through a working relay lane are NOT relay credential denies", () => {
  for (const agentBody of ["invalid token", "Unauthorized", "HTTP 401", "session expired — sign in again"]) {
    assert.equal(isRelayCredentialDenyMessage(agentBody), false, agentBody);
  }
});

test("diagnostic-shaped gate: relay lane + relay body only", () => {
  const relayDeny = { path: "relay", status: 401, error: "Relay authentication failed. Check the relay password or sign in again. relay password missing — sign in again to fetch it" };
  assert.equal(isRelayCredentialDeny(relayDeny), true);
  // Same body on a non-relay lane: not a relay verdict.
  assert.equal(isRelayCredentialDeny({ ...relayDeny, path: "tunnel" }), false);
  // Agent body over a working relay lane: keeps the agent-rejection copy.
  assert.equal(isRelayCredentialDeny({ path: "relay", status: 401, error: "invalid token" }), false);
  // Non-auth status: not a credential deny.
  assert.equal(isRelayCredentialDeny({ path: "relay", status: 502, error: "invalid relay password" }), false);
});

test("mobile-parity superset (commit 43b40bcbe semantics): bare relay-leg 401 is an auth failure", () => {
  assert.equal(isRelayAuthFailure("Relay yaver-free returned HTTP 401"), true);
  assert.equal(isRelayAuthFailure("relay session expired (reason=dead_token)"), true);
  assert.equal(isRelayAuthFailure("HTTP 401"), false, "a 401 with no relay context is not a relay failure");
});

test("connection-error classifier names the relay credential failure, not 'Unauthorized'", () => {
  const classified = classifyFetchError({
    response: { status: 401 },
    path: "relay",
    error: new Error("Relay authentication failed. Check the relay password or sign in again. relay password missing — sign in again to fetch it"),
  });
  assert.equal(classified.reason, "relay-credential");
  assert.match(classified.detail, /relay password/i);
  assert.match(classified.detail, /sign(ing)? in again/i);
  // A genuine agent 401 keeps the generic unauthorized classification.
  const agent401 = classifyFetchError({ response: { status: 401 }, path: "relay", error: new Error("invalid token") });
  assert.equal(agent401.reason, "unauthorized");
  // And summarizeFailures surfaces the credential verdict over transport noise.
  const summary = summarizeFailures([
    { path: "direct", ok: false, error: "blocked: browser refuses http:// from https:// origin" },
    { path: "relay", ok: false, status: 401, error: "relay password missing — sign in again to fetch it" },
  ]);
  assert.equal(summary?.reason, "relay-credential");
});

// ── Structural: the panel consumes the classifier ───────────────────────────

test("the dashboard connect-error panel attributes relay credential 401s to the relay", () => {
  const page = readFileSync(join(root, "app/dashboard/page.tsx"), "utf8");
  assert.match(page, /isRelayCredentialDeny/, "page.tsx must consume the shared classifier");
  assert.match(
    page,
    /relayCredentialDenied\s*\?\s*\n?\s*"Relay refused the request/,
    "the headline must name the relay, before the anyReached agent-rejection copy",
  );
  // The agent-rejection copy must still exist for genuine agent 401s.
  assert.match(page, /Agent responded, but the connection was rejected/);
});

// ── Stable machine codes (landed relay-side 2026-07-28) ─────────────────────

test("every stable code this file knows is actually emitted by the relay", () => {
  // Keyed off the CODE, not the copy: if the relay renames one, this fails
  // here instead of silently degrading every surface to the prose fallback.
  const guardSrc = readFileSync(join(root, "../relay/abuse_guard.go"), "utf8");
  for (const code of Object.values(RELAY_DENY_CODES)) {
    assert.ok(
      guardSrc.includes(`"${code}"`),
      `relay/abuse_guard.go must still define the stable code ${JSON.stringify(code)}`,
    );
  }
});

test("the stable code decides, with no prose to match on", () => {
  // Deliberately unrecognisable prose — only the code says what happened.
  assert.equal(
    isRelayCredentialDenyMessage('HTTP 401: {"ok":false,"code":"relay_password_missing","error":"nope"}'),
    true,
  );
  assert.equal(
    isRelayCredentialDenyMessage('{"ok":false,"code":"relay_password_invalid","error":"nope"}'),
    true,
  );
  assert.equal(isRelayCredentialDenyCode("relay_password_rate_limited"), true);
  // The pre-fix relay's code is NOT a credential signal — every 401 carries it.
  assert.equal(isRelayCredentialDenyCode("Unauthorized"), false);
  assert.equal(isRelayCredentialDenyCode(undefined), false);
});

test("a stable code is authoritative in the NEGATIVE direction too", () => {
  // Both bodies contain the word "relay"; without the code the prose leg could
  // sweep them up. The relay authorized us fine here — the tunnel is missing.
  assert.equal(
    isRelayCredentialDenyMessage('{"ok":false,"code":"relay.device_not_connected","error":"device not connected to relay"}'),
    false,
  );
  assert.equal(
    isRelayCredentialDenyMessage('{"ok":false,"code":"relay.device_owner_mismatch","error":"device not connected to relay"}'),
    false,
  );
  // A backend blip must never be "self-healed" as a bad credential.
  assert.equal(
    isRelayCredentialDenyMessage('{"ok":false,"code":"relay_auth_backend_unavailable","error":"relay auth backend unavailable — retry"}'),
    false,
  );
});

test("PROSE FALLBACK SURVIVES: public.yaver.io is redeployed by hand", () => {
  // Until the manual scp lands, the LIVE relay still answers code:"Unauthorized"
  // with the old prose. Deleting the prose path would break every device card
  // against the deployed relay, so this pins it.
  assert.equal(
    isRelayCredentialDenyMessage(
      '{"ok":false,"code":"Unauthorized","error":"relay password missing — sign in again to fetch it"}',
    ),
    true,
  );
  assert.equal(isRelayCredentialDenyMessage("invalid relay password"), true);
  assert.equal(relayDenyCodeFromBody("not json at all"), null);
  assert.equal(relayDenyCodeFromBody('{"code":"relay_password_missing"}'), "relay_password_missing");
});

test("the diagnostic gate prefers an explicitly-parsed code over the prose", () => {
  assert.equal(
    isRelayCredentialDeny({ path: "relay", status: 401, code: "relay_password_missing", error: "nope" }),
    true,
  );
  // The lane gate still wins — a code alone does not make a non-relay leg one.
  assert.equal(
    isRelayCredentialDeny({ path: "tunnel", status: 401, code: "relay_password_missing" }),
    false,
  );
});
