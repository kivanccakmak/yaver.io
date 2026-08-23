import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  clientRuntimeLogsNeedProjectFix,
  previewAgentHealthIsAuthoritative,
  previewHealthCanOfferProjectFix,
  previewLogsLookHealthy,
  previewPaintGateMode,
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
    "[web:error] resource failed SCRIPT https://relay.example/d/device/dev-web/entry.bundle?token=[redacted]",
  ]), true);
  assert.equal(clientRuntimeLogsNeedProjectFix([
    "[web:error] SyntaxError: Unexpected token '<' @ https://relay.example/?token=[redacted]",
  ]), true);
  assert.equal(clientRuntimeLogsNeedProjectFix([
    "queued",
    "$ npm run web",
    "Bundled 4814ms",
    "ready - started server on 0.0.0.0:3000",
  ]), false);
  assert.equal(clientRuntimeLogsNeedProjectFix([]), false);
});

test("terminal Expo failure outranks earlier Metro startup noise", () => {
  const sfmgTail = [
    "Starting Metro Bundler",
    "CommandError: It looks like you're trying to use TypeScript but don't have the required dependencies installed.",
    "Install typescript@~5.9.2 by running: npx expo install typescript",
    "Failed to start expo: npx exited before becoming ready: exit status 1",
  ];
  assert.equal(previewLogsLookHealthy(sfmgTail), false);
  assert.equal(previewLogsLookHealthy(["Starting Metro Bundler"]), false);
  assert.equal(previewLogsLookHealthy(["Starting Metro Bundler", "Web Bundled 4814ms"]), true);
  assert.equal(previewLogsLookHealthy(["Web Bundled 4814ms"], "expo exited before becoming ready"), false);
});

test("cross-origin paint gating negotiates the agent signal instead of inferring it", () => {
  const oldAgent = { previewHealth: { state: "healthy", canOfferProjectFix: false } };
  const currentAgent = {
    previewHealth: { state: "healthy", canOfferProjectFix: false, paintSignal: "in_frame_v1" },
  };
  assert.equal(previewPaintGateMode(oldAgent, {
    contentLoaded: false, failed: false, probeUnavailable: "cross-origin",
  }), "blocking", "an unverified frame must never be presented as rendered");
  assert.equal(previewPaintGateMode(currentAgent, {
    contentLoaded: false, failed: false, probeUnavailable: "cross-origin",
  }), "blocking");
  assert.equal(previewPaintGateMode(oldAgent, {
    contentLoaded: false, failed: true, probeUnavailable: "cross-origin",
  }), "blocking", "a real failure must stay visible even when paint telemetry is unavailable");
  assert.equal(previewPaintGateMode(oldAgent, {
    contentLoaded: true, failed: false, probeUnavailable: "cross-origin",
  }), "confirmed");
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
    assert.match(src, /previewPaintGateMode/, `${rel} must negotiate the paint channel`);
    assert.doesNotMatch(
      src,
      /function previewLogsLookHealthy/,
      `${rel} must not carry a local copy of the terminal-state classifier`,
    );
  }
});
