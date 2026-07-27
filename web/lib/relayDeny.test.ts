/**
 * relayDeny.test.ts — `npx tsx lib/relayDeny.test.ts`.
 *
 * Pins the named-verdict layer for relay denies (audit gaps R3, R13, R14):
 *  1. behavior against the relay's REAL error strings (read from
 *     relay/server.go + relay/bandwidth.go so drift there fails here);
 *  2. web/mobile parity — the two relayDeny.ts twins must carry identical
 *     logic, or the "named on one surface only" defect ships again.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyRelayLimit, explainRelayDeny } from "./relayDeny";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(webRoot, "..");

test("device_mismatch: named, terminal, remedy carries `yaver auth`", () => {
  // The exact string relay/server.go rejects with.
  const relaySrc = readFileSync(join(repoRoot, "relay/server.go"), "utf8");
  assert.match(relaySrc, /reason=device_mismatch/, "relay deny reason renamed — update relayDeny.ts");

  const msg = explainRelayDeny("relay password owner does not own this deviceId (reason=device_mismatch)");
  assert.ok(msg, "device_mismatch must be explained");
  assert.match(msg!, /different Yaver account/);
  assert.match(msg!, /yaver auth/);
  assert.match(msg!, /can't help/i);
});

test("healable causes are NOT declared terminal", () => {
  assert.equal(explainRelayDeny("invalid relay password (reason=bad_password)"), null);
  assert.equal(explainRelayDeny("device not connected to relay"), null);
  assert.equal(explainRelayDeny(""), null);
  assert.equal(explainRelayDeny(null), null);
});

test("bandwidth cap: parses the relay's real format, names the reset + unmetered paths", () => {
  const bwSrc = readFileSync(join(repoRoot, "relay/bandwidth.go"), "utf8");
  assert.match(bwSrc, /bandwidth limit exceeded: %dMB used of %dMB daily limit/, "relay bandwidth string changed — update relayDeny.ts");

  const card = classifyRelayLimit("bandwidth limit exceeded: 120MB used of 100MB daily limit (device abcd1234)");
  assert.ok(card);
  assert.equal(card!.kind, "bandwidth-cap");
  assert.match(card!.detail, /120 MB/);
  assert.match(card!.detail, /100 MB/);
  assert.match(card!.detail, /resets daily/i);
  assert.match(card!.detail, /unmetered/);
  assert.match(card!.detail, /cut by the cap/);
});

test("free-tier rate limit: the relay's exact string gets its own card", () => {
  const relaySrc = readFileSync(join(repoRoot, "relay/server.go"), "utf8");
  assert.match(relaySrc, /free relay user rate limit exceeded/);

  const card = classifyRelayLimit("free relay user rate limit exceeded");
  assert.ok(card);
  assert.equal(card!.kind, "free-tier-rate");
  const generic = classifyRelayLimit("rate limit exceeded");
  assert.ok(generic);
  assert.equal(generic!.kind, "rate-limit");
});

test("non-limit errors yield no card", () => {
  assert.equal(classifyRelayLimit("device not connected to relay"), null);
  assert.equal(classifyRelayLimit(null), null);
});

test("web/mobile twins are byte-identical below the header comment", () => {
  const strip = (src: string) => src.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n").trim();
  const web = strip(readFileSync(join(webRoot, "lib/relayDeny.ts"), "utf8"));
  const mobile = strip(readFileSync(join(repoRoot, "mobile/src/lib/relayDeny.ts"), "utf8"));
  assert.equal(web, mobile, "relayDeny twins drifted — sync web/lib/relayDeny.ts and mobile/src/lib/relayDeny.ts");
});
