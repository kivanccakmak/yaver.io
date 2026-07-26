/**
 * preview-device-proxy.test.ts — `npx tsx lib/preview-device-proxy.test.ts`.
 * Pins the same-origin /d/<device> proxy auth contract.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { previewDeviceProxyHeaders } from "./preview-device-proxy";

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
