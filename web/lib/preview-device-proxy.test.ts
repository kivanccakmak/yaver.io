/**
 * preview-device-proxy.test.ts — `npx tsx lib/preview-device-proxy.test.ts`.
 * Pins the same-origin /d/<device> proxy auth contract.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { previewDeviceProxyHeaders } from "./preview-device-proxy";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("same-origin device proxy forwards bearer auth and relay password", () => {
  const input = new Headers({
    accept: "application/json",
    authorization: "Bearer stale-browser-header",
    "x-relay-password": "client-side-value",
  });

  const headers = previewDeviceProxyHeaders(input, "current-dashboard-token", "server-relay-password");

  assert.equal(headers.get("accept"), "application/json");
  assert.equal(headers.get("authorization"), "Bearer current-dashboard-token");
  assert.equal(headers.get("x-relay-password"), "server-relay-password");
});

test("same-origin device proxy answers CORS preflight locally", () => {
  const route = readFileSync(join(webRoot, "app/d/[deviceId]/[[...path]]/route.ts"), "utf8");

  assert.match(route, /function preflightResponse/, "proxy route needs a local preflight response");
  assert.match(route, /Access-Control-Allow-Headers/, "preflight must echo or allow browser request headers");
  assert.match(route, /export async function OPTIONS[\s\S]*return preflightResponse\(request\)/, "OPTIONS must not proxy to the relay/device");
});
