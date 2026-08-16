import test from "node:test";
import assert from "node:assert/strict";

import { classifyTransport } from "./transport.ts";

test("classifyTransport reports Yaver Mesh before Tailscale for mesh overlay IPs", () => {
  const info = classifyTransport({
    localIps: ["100.96.5.17", "100.89.155.25"],
    port: 18080,
  });

  assert.equal(info.primary, "yaver-mesh");
  assert.equal(info.label, "Yaver Mesh");
  assert.match(info.detail, /100\.96\.5\.17/);
});

test("classifyTransport still reports Tailscale for non-mesh CGNAT IPs", () => {
  const info = classifyTransport({
    localIps: ["100.89.155.25"],
    port: 18080,
  });

  // `primary` is the CLASSIFICATION and is what every routing decision keys
  // off — it stays "tailscale" and is the real assertion here.
  assert.equal(info.primary, "tailscale");
  // The LABEL is user-facing copy and is deliberately vendor-neutral: the
  // dashboard says "Private network", not "Tailscale". Asserting the vendor
  // name here made a copy decision look like a regression. Pin the contract
  // (classification + address), not the marketing string.
  assert.equal(info.label, "Private network");
  assert.match(info.detail, /100\.89\.155\.25/);
});
