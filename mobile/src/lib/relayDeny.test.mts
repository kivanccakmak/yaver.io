// relayDeny.test.mts — mobile side of the named relay-verdict layer
// (audit gaps R3, R13, R14). The deep parity + relay-string drift checks
// live in web/lib/relayDeny.test.ts; this pins the mobile twin's behavior
// and that DeviceContext actually consumes it (a named verdict with zero
// consumers is the T7 dead-code defect again).
// Run: node --experimental-strip-types --test src/lib/relayDeny.test.mts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyRelayLimit, explainRelayDeny } from "./relayDeny.ts";

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("device_mismatch is named terminal with a remedy", () => {
  const msg = explainRelayDeny("relay password owner does not own this deviceId (reason=device_mismatch)");
  assert.ok(msg);
  assert.match(msg!, /different Yaver account/);
  assert.match(msg!, /yaver auth/);
});

test("healable causes return null (repair/topology rungs keep the wheel)", () => {
  assert.equal(explainRelayDeny("invalid relay password (reason=bad_password)"), null);
  assert.equal(explainRelayDeny("device not connected to relay"), null);
});

test("limit verdicts classify into compact cards", () => {
  assert.equal(classifyRelayLimit("bandwidth limit exceeded: 120MB used of 100MB daily limit (device abcd1234)")!.kind, "bandwidth-cap");
  assert.equal(classifyRelayLimit("free relay user rate limit exceeded")!.kind, "free-tier-rate");
  assert.equal(classifyRelayLimit("all good"), null);
});

test("DeviceContext consumes the named verdicts (no dead seam)", () => {
  const src = readFileSync(join(mobileRoot, "src/context/DeviceContext.tsx"), "utf8");
  assert.match(src, /from "..\/lib\/relayDeny"/, "DeviceContext must import relayDeny");
  assert.match(src, /explainRelayDeny/, "DeviceContext must call explainRelayDeny");
  assert.match(src, /classifyRelayLimit/, "DeviceContext must call classifyRelayLimit");
});
