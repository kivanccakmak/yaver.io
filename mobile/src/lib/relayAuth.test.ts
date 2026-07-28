/**
 * relayAuth.test.ts — `npx tsx src/lib/relayAuth.test.ts`.
 * No RN, no jest — the tiny assert harness.
 *
 * Pins the unified relay-auth classifier behind the 2026-07-28 incident: the
 * sim sat at "Connecting" because the relay rejected a stale relay password
 * with 401, stringified as "Relay <id> returned HTTP 401" — a message that
 * NONE of the three prior matchers recognized, so the relay-credential refresh
 * never fired. Each block proves the fix AND breaks it (the bare-401 form that
 * the old phrase-only matchers missed).
 */
import { isRelayAuthFailure } from "./relayAuth";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}`); }
}

// THE regression: the bare status form the old matchers all missed.
check("relay 401 leg string is classified as auth failure", isRelayAuthFailure("Relay yaver-free returned HTTP 401"));
check("detailed leg 'relay: Relay X returned HTTP 401'", isRelayAuthFailure("Could not reach agent — direct: no LAN address answered; relay: Relay yaver-free returned HTTP 401"));
check("relay 403 throttle string", isRelayAuthFailure("Relay yaver-free returned HTTP 403"));

// Worded forms every prior matcher agreed on — must still match.
check("'relay authentication failed'", isRelayAuthFailure("Relay authentication failed. Check the relay password or sign in again."));
check("'invalid relay password'", isRelayAuthFailure("invalid relay password"));
check("'relay password mismatch'", isRelayAuthFailure("relay password mismatch"));
check("'reason=bad_password'", isRelayAuthFailure("connect refused reason=bad_password"));
check("'reason=dead_token'", isRelayAuthFailure("reason=dead_token"));
check("'too many invalid relay password attempts'", isRelayAuthFailure("too many invalid relay password attempts"));

// Must NOT over-match: a non-relay failure, or a relay topology failure that a
// credential refresh does NOT fix, must be left alone.
check("null/empty is not an auth failure", !isRelayAuthFailure(null) && !isRelayAuthFailure(""));
check("direct-leg 401 (no 'relay') is not classified as relay-auth", !isRelayAuthFailure("direct 192.168.1.5 returned HTTP 401"));
check("'device not connected to relay' (topology, not auth) is NOT auth", !isRelayAuthFailure("relay: device not connected to relay"));
check("plain network error is not auth", !isRelayAuthFailure("Network request failed"));

// NEGATIVE CONTROL — the OLD phrase-only matcher (what DeviceContext had) would
// MISS the bare-401 form. Model it and assert it reproduces the miss, proving
// the new classifier is strictly stronger, not a restatement.
const oldPhraseOnly = (msg: string) => {
  const m = msg.toLowerCase();
  return m.includes("invalid relay password") || m.includes("relay password mismatch") ||
    m.includes("too many invalid relay password attempts") || m.includes("relay authentication failed");
};
check("negative control: old matcher MISSED 'returned HTTP 401' (the bug)", oldPhraseOnly("Relay yaver-free returned HTTP 401") === false);
check("new matcher CATCHES what the old one missed", isRelayAuthFailure("Relay yaver-free returned HTTP 401") === true);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
if (failures > 0) process.exit(1);
