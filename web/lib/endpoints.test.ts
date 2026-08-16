/**
 * endpoints.test.ts — `npx tsx lib/endpoints.test.ts`
 *
 * Pins the ONE known-dead-endpoint predicate (lib/endpoints.ts) two ways:
 *
 *  1. behavior — stale `<uuid>.yaver.io` rows (no wildcard *.yaver.io DNS) and
 *     `*.dev.yaver.io` rows (no wildcard cert) are excluded; every legitimate
 *     shape (public.yaver.io, path-style /d/<id>, custom/self-hosted domains,
 *     LAN serve URLs) passes.
 *  2. structure — every call site that unions `publicEndpoints ∪ tunnelUrl`
 *     imports the SHARED predicate instead of carrying a private regex. This
 *     codebase's defining bug is the duplicated derive; a re-grown private
 *     copy fails here.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isUsablePublicEndpoint, usableTunnelUrls } from "./endpoints";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const DEAD_UUID = "2ed7da41-1234-4abc-8def-0123456789ab";

test("stale <uuid>.yaver.io endpoints are dead — no wildcard *.yaver.io DNS", () => {
  assert.equal(isUsablePublicEndpoint(`https://${DEAD_UUID}.yaver.io`), false);
  assert.equal(isUsablePublicEndpoint(`https://${DEAD_UUID}.yaver.io/`), false);
  assert.equal(isUsablePublicEndpoint(`https://${DEAD_UUID}.yaver.io/health`), false);
  assert.equal(isUsablePublicEndpoint(`http://${DEAD_UUID}.yaver.io`), false);
  // Case-insensitive scheme/host.
  assert.equal(isUsablePublicEndpoint(`HTTPS://${DEAD_UUID.toUpperCase()}.YAVER.IO`), false);
});

test("<id>.dev.yaver.io endpoints are dead — wildcard cert not provisioned", () => {
  assert.equal(isUsablePublicEndpoint(`https://${DEAD_UUID}.dev.yaver.io`), false);
  assert.equal(isUsablePublicEndpoint("https://mybox.dev.yaver.io/anything"), false);
});

test("legitimate endpoints stay", () => {
  for (const ok of [
    "https://public.yaver.io",
    `https://public.yaver.io/d/${DEAD_UUID}`, // path-style relay URL — the LIVE format
    "https://relay.example.com",
    "https://my-own-domain.dev", // self-hosted
    "https://tunnel.mycompany.io/yaver",
    "http://192.168.1.20:18080", // LAN serve URL (mixed-content handled elsewhere)
  ]) {
    assert.equal(isUsablePublicEndpoint(ok), true, `${ok} must be usable`);
  }
});

test("empty / junk endpoints are not usable", () => {
  assert.equal(isUsablePublicEndpoint(""), false);
  assert.equal(isUsablePublicEndpoint("   "), false);
});

test("usableTunnelUrls: trims, dedupes, unions tunnelUrl, filters dead shapes", () => {
  const urls = usableTunnelUrls(
    [
      ` https://${DEAD_UUID}.yaver.io `,
      "https://custom.example.com",
      "https://custom.example.com", // dupe
      `https://${DEAD_UUID}.dev.yaver.io`,
      "",
    ],
    "https://tunnel.example.com",
  );
  assert.deepEqual(urls, ["https://custom.example.com", "https://tunnel.example.com"]);
  // Non-array publicEndpoints degrade to just the tunnelUrl.
  assert.deepEqual(usableTunnelUrls(undefined, "https://t.example.com"), ["https://t.example.com"]);
  assert.deepEqual(usableTunnelUrls(null, null), []);
});

// ── Structural: one predicate, many call sites ──────────────────────────────

test("agent-client.ts uses the shared predicate, not a private regex", () => {
  const src = readFileSync(join(root, "lib/agent-client.ts"), "utf8");
  assert.match(src, /from "\.\/endpoints"/, "agent-client must import lib/endpoints");
  // probeDeviceStatus tunnel loop + connect() tunnelCandidates + ownerClaimDevice.
  const uses = src.split("isUsablePublicEndpoint").length - 1;
  assert.ok(uses >= 4, `agent-client must filter every tunnel loop (found ${uses} uses, want >= 4)`);
  assert.doesNotMatch(
    src,
    /dev\\\.yaver\\\.io/,
    "no private dev.yaver.io regex may remain in agent-client — the shared predicate owns it",
  );
});

test("DevicesView.tsx imports the shared predicate instead of a local copy", () => {
  const src = readFileSync(join(root, "components/dashboard/DevicesView.tsx"), "utf8");
  assert.match(src, /import \{ isUsablePublicEndpoint \} from "@\/lib\/endpoints"/);
  assert.doesNotMatch(src, /function isUsablePublicEndpoint/, "local copy must not re-grow");
});

test("dashboard page unions publicEndpoints through usableTunnelUrls only", () => {
  const src = readFileSync(join(root, "app/dashboard/page.tsx"), "utf8");
  assert.match(src, /usableTunnelUrls\(device\.publicEndpoints, device\.tunnelUrl\)/);
  // The old hand-rolled union spread both fields into an unfiltered Set —
  // its signature line must be gone from this file.
  assert.doesNotMatch(
    src,
    /\.\.\.\(Array\.isArray\(device\.publicEndpoints\) \? device\.publicEndpoints : \[\]\)/,
    "page.tsx must not hand-roll an unfiltered publicEndpoints union",
  );
});
