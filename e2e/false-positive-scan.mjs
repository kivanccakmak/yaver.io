#!/usr/bin/env node
// false-positive-scan.mjs — closed-loop "don't scare the user" scanner.
//
// Architecture: docs/architecture/CLOSED_LOOP_FALSE_POSITIVE_TESTING.md.
// This is the CONNECTIVITY cell: establish GROUND TRUTH from the real relay,
// then assert the UI's classifier cannot turn a healthy box into a scary label.
//
//   Oracle:   GET <relay>/d/<id>/health with VALID creds → 200 == reachable
//             AND authorized. Any "can't reach / Unauthorized / offline" badge
//             for such a box is a FALSE POSITIVE.
//   Induce:   the exact self-healable failure — a stale relay password — by
//             probing with a WRONG X-Relay-Password. The relay's real 401 body
//             is what the web reachability probe sees.
//   Assert:   that body matches the relay-credential patterns the web
//             classifier keys on (kept in sync with web/lib/relayAuth.ts),
//             so the fixed UI classifies it as self-healable "Relay refused …"
//             — NEVER the agent-blaming "Unauthorized". A reachable box whose
//             stale-credential 401 body does NOT match is a false-positive gap.
//
// READ-ONLY against the caller's OWN boxes. Owner creds from ~/.yaver/config.json.
// Pairs with web/lib/connection-error.test.ts (the UI-logic half of the loop).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RELAY = process.env.YAVER_RELAY_HTTP || "https://public.yaver.io";
const CONVEX = process.env.YAVER_CONVEX_SITE || "https://perceptive-minnow-557.eu-west-1.convex.site";
const cfg = JSON.parse(readFileSync(join(homedir(), ".yaver", "config.json"), "utf8"));
const TOKEN = cfg.auth_token;
const RELAY_PW = cfg.cached_relay_password || "";

// Kept in sync with web/lib/relayAuth.ts::isRelayCredentialDenyMessage — if the
// relay wording drifts, this scan fails first (a real relay-401 that the web
// would MISCLASSIFY as agent-Unauthorized).
function isRelayCredentialDenyBody(s) {
  const m = String(s || "").toLowerCase();
  return (
    m.includes("relay password missing") ||
    m.includes("invalid relay password") ||
    m.includes("relay password mismatch") ||
    m.includes("too many invalid relay password attempts") ||
    m.includes("reason=bad_password") ||
    m.includes("relay authentication failed")
  );
}

let fails = 0;
const line = (s) => console.log(s);

async function relayProbe(deviceId, path, relayPw) {
  const headers = { Authorization: `Bearer ${TOKEN}` };
  if (relayPw !== undefined) headers["X-Relay-Password"] = relayPw;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(`${RELAY}/d/${deviceId}${path}`, { headers, signal: ctrl.signal });
    const body = await r.text().catch(() => "");
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, body: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function run() {
  if (!TOKEN) { console.error("no auth_token in ~/.yaver/config.json"); process.exit(2); }
  line("false-positive-scan · CONNECTIVITY cell\n");

  const r = await fetch(`${CONVEX}/devices/list`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const j = await r.json().catch(() => ({}));
  const devices = (Array.isArray(j) ? j : j.devices || j.data || []).filter((d) => d.deviceId || d._id);

  let reachable = 0;
  for (const d of devices) {
    const id = d.deviceId || d._id;
    // Oracle: is the box reachable AND authorized right now?
    const health = await relayProbe(id, "/health", RELAY_PW);
    const truthReachable = health.status === 200;
    const tag = `${d.name} · ${String(id).slice(0, 8)}`;
    if (!truthReachable) {
      line(`  ··  ${tag} — not reachable via relay (HTTP ${health.status}); an "offline" badge here is HONEST, skipping`);
      continue;
    }
    reachable++;
    // Induce the self-healable failure: stale relay password.
    const stale = await relayProbe(id, "/info", "definitely-a-stale-password");
    const matches = isRelayCredentialDenyBody(stale.body);
    if (stale.status === 401 && matches) {
      line(`  ok  ${tag} — reachable+authorized; stale-cred 401 body is relay-credential-shaped → UI self-heals, no false "Unauthorized"`);
    } else if (stale.status === 401 && !matches) {
      fails++;
      line(`FAIL  ${tag} — reachable, but stale-cred 401 body would MISCLASSIFY as agent-Unauthorized: ${JSON.stringify(stale.body.slice(0, 120))}`);
    } else {
      // Relay accepted a bogus password, or a different status — worth noting,
      // not a credential-classification failure.
      line(`  ··  ${tag} — reachable; stale-pw probe returned HTTP ${stale.status} (not the expected 401), skipping classifier assert`);
    }
  }

  line(`\n${"─".repeat(56)}`);
  line(`devices: ${devices.length} · reachable+authorized: ${reachable}`);
  if (fails === 0) {
    line("NO FALSE-POSITIVE CONNECTIVITY GAPS — every reachable box's stale-cred 401 classifies as self-healable, not agent-Unauthorized");
  } else {
    line(`${fails} FALSE-POSITIVE GAP(S) — a reachable box would be labeled agent-Unauthorized`);
    process.exit(1);
  }
}

run().catch((e) => { console.error("scan crashed:", e); process.exit(2); });
