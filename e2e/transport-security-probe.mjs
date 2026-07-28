#!/usr/bin/env node
// transport-security-probe.mjs — headless transport-layer security probe.
//
// Runs against the REAL agent over the free relay (no mocks, repo house style)
// to establish GROUND TRUTH: what does the transport layer actually enforce?
// It is the "secure the transport first, then compare client surfaces" step —
// the agent is the authority; every client (mobile quic.ts, web, tvOS, watch,
// Wear) must send exactly what the agent requires and nothing that lets a
// stranger in.
//
// Invariants asserted (from ROBUST_TRANSPORT_SSH_QUIC.md §4d + CLAUDE.md relay
// rules + the 2026-07-28 security handoff):
//   A. PASS-THROUGH RELAY. The relay authorizes NOTHING. A privileged request
//      that reaches the agent with no/'bad credentials is rejected BY THE AGENT
//      (401/403), never silently allowed because it came via the relay.
//   B. AUTH ON PRIVILEGED ROUTES. /ops (and other control routes) require a
//      valid owner/session bearer. No token, garbage token, wrong-user token →
//      rejected. A 200 here is a transport-security failure.
//   C. HONEST OPEN ROUTES. /health + the pairing/lifecycle surface are
//      intentionally open (a phone must learn a box is reachable before it has
//      proven itself). We RECORD these, and assert they leak nothing privileged.
//   D. NO FALSE-LOCAL. A relay-bridged request must not be treated as loopback
//      (handoff §2.4 / §4.4): builds/dev routes must not admit a relayed caller
//      as "genuinely local".
//
// READ-ONLY. Every probe is a GET or an idempotent info verb against the
// caller's OWN box (Yaver-owned resource — authorized). No writes, no deletes.
//
// Usage:  node e2e/transport-security-probe.mjs [deviceId]
// Reads owner creds from ~/.yaver/config.json. Exit 1 if any INVARIANT fails
// (recorded-posture findings are reported but do not fail the run unless they
// violate an invariant).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RELAY = process.env.YAVER_RELAY_HTTP || "https://public.yaver.io";
const DEVICE_ID = process.argv[2] || "5e79cf10-90e8-4a4f-bf07-041061dca210";
const TIMEOUT_MS = 12000;

const cfg = JSON.parse(readFileSync(join(homedir(), ".yaver", "config.json"), "utf8"));
const OWNER = cfg.auth_token;
const RELAY_PW = cfg.cached_relay_password || "";
if (!OWNER) {
  console.error("no auth_token in ~/.yaver/config.json — sign in first");
  process.exit(2);
}

const base = `${RELAY}/d/${DEVICE_ID}`;
let invariantFailures = 0;
const posture = [];

function ok(name, cond, detail = "") {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${detail ? `  — ${detail}` : ""}`);
  if (!cond) invariantFailures++;
}
function record(name, detail) {
  posture.push({ name, detail });
  console.log(`  ··  ${name}  — ${detail}`);
}

async function probe(method, path, { token, relayPw, body } = {}) {
  const headers = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  if (relayPw !== undefined) headers["X-Relay-Password"] = relayPw;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { status: res.status, ms: Date.now() - t0, text };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, text: String(e && e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

const GARBAGE = "not-a-real-token-" + "x".repeat(40);

async function run() {
  console.log(`transport-security-probe → ${base}\n`);

  // ── Baseline: transport works with owner creds ──────────────────────────
  console.log("baseline — owner creds reach the agent over the relay");
  const infoOwner = await probe("GET", "/info", { token: OWNER, relayPw: RELAY_PW });
  ok("GET /info with owner token → 200 (transport up)", infoOwner.status === 200, `HTTP ${infoOwner.status} in ${infoOwner.ms}ms`);
  let agentVersion = "?";
  try { agentVersion = JSON.parse(infoOwner.text).version || "?"; } catch {}
  record("deployed agent version", agentVersion);

  // ── C. Honest open routes ───────────────────────────────────────────────
  console.log("\nC — intentionally-open lifecycle routes (record posture)");
  const healthNoAuth = await probe("GET", "/health", {});
  record("GET /health no-auth", `HTTP ${healthNoAuth.status} (open by design so a phone can learn reachability)`);
  // /health must not leak anything privileged (tokens, paths, secrets).
  const leaks = /auth_token|passwordHash|relayPassword|speechApiKey|\/Users\/|\/home\//.test(healthNoAuth.text);
  ok("open /health leaks no secret/path", !leaks, leaks ? "LEAK in /health body" : "clean");

  // ── B. Auth enforced on privileged control routes ───────────────────────
  console.log("\nB — /ops (privileged control) must reject unauthenticated + bad-token");
  const opsNoAuth = await probe("POST", "/ops", { relayPw: RELAY_PW, body: { verb: "get_info" } });
  ok("POST /ops NO token → rejected (401/403), NOT 200", opsNoAuth.status === 401 || opsNoAuth.status === 403, `HTTP ${opsNoAuth.status}`);
  const opsGarbage = await probe("POST", "/ops", { token: GARBAGE, relayPw: RELAY_PW, body: { verb: "get_info" } });
  ok("POST /ops garbage token → rejected (401/403)", opsGarbage.status === 401 || opsGarbage.status === 403, `HTTP ${opsGarbage.status}`);

  // ── A. Relay is pass-through — the AGENT enforces, not the relay ─────────
  console.log("\nA — relay is pass-through: a valid owner token still works with a WRONG relay password");
  // The relay authorizes nothing; the agent authenticates the token. A wrong
  // relay password must not be what gates access (and must not be a second
  // 'secret request shape' standing in for a key). Either the relay ignores it
  // (agent still 200s) or the relay password is a capacity gate, not identity.
  const wrongPw = await probe("GET", "/info", { token: OWNER, relayPw: "wrong-relay-pw" });
  record("GET /info owner token + WRONG relay pw", `HTTP ${wrongPw.status} (relay must not authorize identity; token is the gate)`);

  // ── D. No false-local: a relayed caller is NOT loopback ──────────────────
  console.log("\nD — a relay-bridged caller must not be treated as genuinely local");
  // /builds admitting a relayed request as loopback with no auth was the RCE in
  // handoff §2.4. Probe it UNauthenticated over the relay: it must reject.
  const buildsNoAuth = await probe("POST", "/builds", { relayPw: RELAY_PW, body: {} });
  ok("POST /builds no-auth over relay → rejected (not admitted as local)", buildsNoAuth.status === 401 || buildsNoAuth.status === 403 || buildsNoAuth.status === 404, `HTTP ${buildsNoAuth.status}`);

  // ── Handoff §4.4 transport findings — verify on the DEPLOYED agent ───────
  console.log("\n§4.4 — deployed-agent transport findings (record; may be unshipped fixes)");
  const userinfoGarbage = await probe("GET", "/oauth/userinfo", { token: GARBAGE });
  // Handoff: returns 200 for ANY bearer. That IS a transport-auth failure if true.
  ok("GET /oauth/userinfo garbage bearer → NOT 200", userinfoGarbage.status !== 200, `HTTP ${userinfoGarbage.status}`);
  const devNoAuth = await probe("GET", "/dev/", {});
  record("GET /dev/ no-auth", `HTTP ${devNoAuth.status} (handoff §4.4: unauth reverse proxy — should require auth)`);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`posture recorded: ${posture.length} item(s)`);
  if (invariantFailures === 0) {
    console.log("ALL TRANSPORT INVARIANTS HOLD");
  } else {
    console.log(`${invariantFailures} TRANSPORT INVARIANT(S) VIOLATED`);
    process.exit(1);
  }
}

run().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(2);
});
