import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  clientRuntimeLogsNeedProjectFix,
  previewAgentHealthIsAuthoritative,
  previewHealthCanOfferProjectFix,
} from "./previewHealth.ts";

const alwaysFix = () => true;
const neverFix = () => false;

test("an authoritative healthy agent verdict suppresses the fix even when local heuristics scream", () => {
  const status = { previewHealth: { state: "healthy", canOfferProjectFix: false } };
  assert.equal(previewAgentHealthIsAuthoritative(status), true);
  assert.equal(previewHealthCanOfferProjectFix(status, ["Failed to compile application."], alwaysFix), false);
});

test("needs_project_fix from the agent offers the fix", () => {
  const status = { previewHealth: { state: "needs_project_fix", canOfferProjectFix: true } };
  assert.equal(previewHealthCanOfferProjectFix(status, [], neverFix), true);
});

test("a deterministic repair route wins over the coding-agent escalation", () => {
  const status = {
    previewHealth: { state: "needs_project_fix", canOfferProjectFix: true, hasDeterministicFix: true },
  };
  assert.equal(previewHealthCanOfferProjectFix(status, [], alwaysFix), false);
});

test("older agents without the signal fall back to local heuristics", () => {
  assert.equal(previewAgentHealthIsAuthoritative({}), false);
  assert.equal(previewHealthCanOfferProjectFix({}, ["boom"], alwaysFix), true);
  assert.equal(previewHealthCanOfferProjectFix(null, ["boom"], neverFix), false);
});

test("client console crashes escalate; startup noise does not", () => {
  assert.equal(clientRuntimeLogsNeedProjectFix([
    "TypeError: undefined is not a function (near '...store.dispatch...')",
  ]), true);
  assert.equal(clientRuntimeLogsNeedProjectFix([
    "Uncaught ReferenceError: foo is not defined",
  ]), true);
  assert.equal(clientRuntimeLogsNeedProjectFix([
    "queued",
    "$ npm run web",
    "Bundled 4814ms",
    "ready - started server on 0.0.0.0:3000",
  ]), false);
  assert.equal(clientRuntimeLogsNeedProjectFix([]), false);
});

// Parity: both browser-preview implementations must consume THIS module —
// a reintroduced local copy of the gate is drift by construction.
test("both preview implementations import the shared gate", () => {
  const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  for (const rel of ["app/(tabs)/apps.tsx", "src/components/DevPreview.tsx"]) {
    const src = readFileSync(join(mobileRoot, rel), "utf8");
    assert.match(src, /from "[^"]*lib\/previewHealth"/, `${rel} must import lib/previewHealth`);
    assert.doesNotMatch(
      src,
      /function previewHealthCanOfferProjectFix/,
      `${rel} must not carry a local copy of the gate`,
    );
  }
});
