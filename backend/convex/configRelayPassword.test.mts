// Run: node --experimental-strip-types --test convex/configRelayPassword.test.mts
// (from backend/).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const httpSource = readFileSync(join(import.meta.dirname, "http.ts"), "utf8");

test("authenticated /config attaches the caller relay password, not the platform secret", () => {
  assert.match(httpSource, /request\.headers\.get\("Authorization"\)/, "/config must inspect bearer auth");
  assert.match(httpSource, /api\.userSettings\.getByToken/, "/config must read the caller's settings row");
  assert.match(httpSource, /userRelayPassword = typeof settings\?\.relayPassword === "string" \? settings\.relayPassword : undefined/, "/config must source relay password from userSettings");
  assert.match(httpSource, /const \{ password: _password, \.\.\.publicServer \}/, "/config must still strip the platform relay password");
  assert.match(httpSource, /return \{ \.\.\.publicServer, password: userRelayPassword \}/, "/config must attach only the per-user relay password");
});

test("private relay-password config responses are not publicly cached", () => {
  assert.match(httpSource, /"Cache-Control": userRelayPassword \? "private, no-store" : "public, max-age=300"/);
});
