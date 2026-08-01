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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isRelayAuthFailure,
  isRelayDenyCode,
  isRelayTunnelDown,
  relayDenyCodeFromBody,
  RELAY_DENY_CODES,
  RELAY_TUNNEL_DOWN_REMEDY,
} from "./relayAuth";

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

// ── STABLE CODES (landed relay-side 2026-07-28) ─────────────────────────────
// Before them, `code` was http.StatusText — the literal "Unauthorized" every
// 401 carries — which is why every surface regexed English in the first place.

// Keyed off the CODE, not the copy: a relay-side rename fails HERE, loudly,
// instead of silently degrading this app to the prose fallback.
const relayGuardSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../relay/abuse_guard.go"),
  "utf8",
);
for (const code of Object.values(RELAY_DENY_CODES)) {
  check(`relay/abuse_guard.go still defines ${code}`, relayGuardSrc.includes(`"${code}"`));
}

// The code decides with NO recognisable prose to fall back on.
check("code-only: relay_password_missing", isRelayAuthFailure('HTTP 401: {"ok":false,"code":"relay_password_missing","error":"nope"}'));
check("code-only: relay_password_invalid", isRelayAuthFailure('{"ok":false,"code":"relay_password_invalid","error":"nope"}'));
check("isRelayDenyCode exact-matches", isRelayDenyCode("relay_password_rate_limited") && !isRelayDenyCode("Unauthorized") && !isRelayDenyCode(null));
check("relayDenyCodeFromBody extracts from a wrapped body", relayDenyCodeFromBody('Relay x returned HTTP 401: {"code":"relay_password_missing"}') === "relay_password_missing");
check("relayDenyCodeFromBody on non-JSON is null", relayDenyCodeFromBody("Relay x returned HTTP 401") === null);

// Authoritative in the NEGATIVE direction. These pass today with or without
// the code layer — no CURRENT prose leg collides with them — so they are a
// FORWARD guard: the moment someone widens the prose (or the relay reworders a
// 502/503), the code keeps the verdict correct. The break-proof for the code
// layer is the `relay_password_invalid` case above, which fails the instant
// relayDenyCodeFromBody stops being consulted.
check("code-only: relay.device_not_connected is NOT a credential failure", !isRelayAuthFailure('relay: HTTP 502: {"ok":false,"code":"relay.device_not_connected","error":"device not connected to relay"}'));
check("code-only: relay.device_owner_mismatch is NOT a credential failure", !isRelayAuthFailure('relay: HTTP 502: {"ok":false,"code":"relay.device_owner_mismatch","error":"device not connected to relay"}'));
check("code-only: relay_auth_backend_unavailable is NOT a credential failure", !isRelayAuthFailure('relay: HTTP 503: {"ok":false,"code":"relay_auth_backend_unavailable","error":"relay auth backend unavailable — retry"}'));

// PROSE FALLBACK IS LOAD-BEARING. public.yaver.io is redeployed by MANUAL scp,
// so the live relay still answers code:"Unauthorized" with the old wording.
check("prose fallback: pre-fix relay body still classifies", isRelayAuthFailure('{"ok":false,"code":"Unauthorized","error":"relay password missing — sign in again to fetch it"}'));

// --- tunnel-down: the relay answered and had nothing to forward to ---------
//
// 2026-08-01, ubuntu-4gb-hel1-1: session expired -> relay refused the box's
// registration -> no tunnel -> every probe 502. Anything that reads "a status
// arrived" as "the agent answered" blames a machine that was never contacted.

check("502 on the relay leg is tunnel-down, not the agent answering", isRelayTunnelDown({ path: "relay", status: 502 }));
check("503 counts too", isRelayTunnelDown({ path: "relay", status: 503 }));
check("504 counts too", isRelayTunnelDown({ path: "relay", status: 504 }));
check(
  "the stable code wins even on a non-gateway status",
  isRelayTunnelDown({ path: "relay", status: 404, error: '{"ok":false,"code":"relay.device_not_connected","error":"device not connected to relay"}' }),
);
check("a healthy relay response is not tunnel-down", !isRelayTunnelDown({ path: "relay", status: 200 }));
check("only the relay leg can be tunnel-down", !isRelayTunnelDown({ path: "direct", status: 502 }));

// The two failures have DIFFERENT remedies (sign in HERE vs sign in on the
// BOX). Counting one as the other sends the user to press a button that
// cannot help.
check("a credential deny is never tunnel-down", !isRelayTunnelDown({ path: "relay", status: 401, code: "relay_password_missing" }));
check("tunnel-down is never a credential failure", !isRelayAuthFailure('relay: HTTP 502: {"ok":false,"code":"relay.device_not_connected","error":"device not connected to relay"}'));

// PARITY. The web twin must say the SAME sentence — a user who reads one
// diagnosis on their phone and another in the browser learns that Yaver's
// answer depends on which screen they picked up.
{
  const webSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../web/lib/relayAuth.ts"), "utf8");
  // Compare the STRING the constant evaluates to, not the surrounding source:
  // the two files carry different comments, and comment drift is not copy
  // drift. Concatenated literals are joined the way the runtime would.
  const grab = (src: string) => {
    const i = src.indexOf("export const RELAY_TUNNEL_DOWN_REMEDY");
    const decl = src.slice(i, src.indexOf(";", i));
    return (decl.match(/"([^"]*)"/g) || []).map((q) => q.slice(1, -1)).join("");
  };
  const mobileSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "relayAuth.ts"), "utf8");
  check("web exposes isRelayTunnelDown", /export function isRelayTunnelDown/.test(webSrc));
  check("the tunnel-down remedy is identical on web and mobile", grab(webSrc) === grab(mobileSrc));
  check(
    "the remedy does not offer web re-auth (it rides the missing tunnel)",
    RELAY_TUNNEL_DOWN_REMEDY.includes("yaver auth") && RELAY_TUNNEL_DOWN_REMEDY.includes("rides the tunnel that is missing"),
  );
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
if (failures > 0) process.exit(1);
