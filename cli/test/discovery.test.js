"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { deviceFromBeacon, YAVER_PORT } = require("../src/discovery");

test("desktop discovery probes the canonical agent port", () => {
  assert.equal(YAVER_PORT, 18080);
});

test("beacon discovery uses the UDP sender address", () => {
  const device = deviceFromBeacon(
    Buffer.from(JSON.stringify({ v: 1, p: 18080, n: "Workstation", id: "dev-1" })),
    { address: "192.0.2.42" },
  );
  assert.deepEqual(device, {
    ip: "192.0.2.42",
    port: 18080,
    name: "Workstation",
    id: "dev-1",
  });
});

test("invalid or addressless beacons are ignored", () => {
  assert.equal(deviceFromBeacon(Buffer.from("not-json"), { address: "192.0.2.42" }), null);
  assert.equal(deviceFromBeacon(Buffer.from(JSON.stringify({ v: 2, p: 18080 })), { address: "192.0.2.42" }), null);
  assert.equal(deviceFromBeacon(Buffer.from(JSON.stringify({ v: 1, p: 18080 })), null), null);
});
