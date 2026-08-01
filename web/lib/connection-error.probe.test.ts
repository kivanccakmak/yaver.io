/**
 * connection-error.probe.test.ts — `npx tsx lib/connection-error.probe.test.ts`
 *
 * 2026-08-01: the Vibing panel told the user to power-cycle `magara` while the
 * Devices panel, on the same screen, showed it "Alive · last agent signal just
 * now". Both were rendering the same failed probe; only one of them had looked
 * at WHY it failed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { probeFailureAllowsBoxAlive } from "./connection-error.ts";

test("a relay verdict is about the RELAY, not proof the box is down", () => {
  for (const msg of [
    "device not connected to relay",
    'HTTP 502: {"ok":false,"code":"relay.device_not_connected"}',
    "Relay refused: account relay password missing or stale",
    "registration rejected: relay session expired (reason=dead_token)",
    "HTTP 503",
    "HTTP 504",
  ]) {
    assert.equal(probeFailureAllowsBoxAlive(msg), true, msg);
  }
});

test("a genuinely dead path is still reported as dead", () => {
  for (const msg of [
    "connection refused",
    "no relay, tunnel, or direct path answered",
    "dial timeout",
    "",
    null,
  ]) {
    assert.equal(probeFailureAllowsBoxAlive(msg), false, String(msg));
  }
});

// STRUCTURE — a signal with no consumer is not shipped. The panel that gave
// the wrong advice must be the one that consults this.
test("RuntimeLabView consumes the classifier at both copy sites", () => {
  const src = readFileSync(new URL("../components/dashboard/RuntimeLabView.tsx", import.meta.url), "utf8");
  const uses = src.split("probeFailureAllowsBoxAlive").length - 1;
  assert.ok(uses >= 3, `expected the import plus both copy sites, saw ${uses}`);
  assert.ok(
    !/not answering on any path, so nothing remote can repair it\. Power it on/.test(
      src.replace(/No relay, tunnel, or direct path answered, so nothing remote can repair it\. Power it on[^<]*/g, ""),
    ),
    "the unconditional power-cycle claim is back",
  );
});
