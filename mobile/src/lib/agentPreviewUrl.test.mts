import assert from "node:assert/strict";
import test from "node:test";

import { probeAgentPreviewRoute, resolveAgentPreviewUrl, waitForAgentPreviewRoute } from "./agentPreviewUrl.ts";

test("relay preview paths retain the device proxy prefix", () => {
  assert.equal(
    resolveAgentPreviewUrl("https://relay.example/d/device-123", "/dev-web/"),
    "https://relay.example/d/device-123/dev-web/",
  );
});

test("direct and tunnel preview paths retain their configured base path", () => {
  assert.equal(
    resolveAgentPreviewUrl("http://127.0.0.1:18080", "/dev-web/?platform=web"),
    "http://127.0.0.1:18080/dev-web/?platform=web",
  );
  assert.equal(
    resolveAgentPreviewUrl("https://tunnel.example/yaver", "/dev/"),
    "https://tunnel.example/yaver/dev/",
  );
});

test("an agent report cannot move a preview to another origin or duplicate an existing prefix", () => {
  assert.equal(
    resolveAgentPreviewUrl("https://relay.example/d/device-123", "https://attacker.invalid/dev-web/?x=1#app"),
    "https://relay.example/d/device-123/dev-web/?x=1#app",
  );
  assert.equal(
    resolveAgentPreviewUrl("https://relay.example/d/device-123", "/d/device-123/dev-web/"),
    "https://relay.example/d/device-123/dev-web/",
  );
});

test("the phone probes the exact relay-scoped handoff route", async () => {
  let requested = "";
  const result = await probeAgentPreviewRoute(
    "https://relay.example/d/device-123/dev-web/",
    { Authorization: "Bearer test" },
    async (url, init) => {
      requested = String(url);
      assert.equal(init?.method, "GET");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test");
      return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
    },
  );
  assert.equal(requested, "https://relay.example/d/device-123/dev-web/");
  assert.deepEqual(result, { ok: true, status: 200, contentType: "text/html" });
});

test("a handoff 404 is a named failure, never a rendered verdict", async () => {
  const result = await probeAgentPreviewRoute(
    "https://relay.example/dev-web/",
    {},
    async () => new Response(null, { status: 404 }),
  );
  assert.deepEqual(result, { ok: false, status: 404, contentType: "unknown" });
});

test("a cold Expo 503 is waited through instead of becoming a terminal Dogfood failure", async () => {
  let attempts = 0;
  const result = await waitForAgentPreviewRoute(
    "https://relay.example/d/device-123/dev/",
    {},
    undefined,
    {
      intervalMs: 0,
      timeoutMs: 100,
      request: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response(null, { status: 503, headers: { "x-yaver-devserver": "starting", "retry-after": "2" } })
          : new Response(null, { status: 200, headers: { "content-type": "text/html" } });
      },
    },
  );
  assert.equal(attempts, 2);
  assert.deepEqual(result, { ok: true, status: 200, contentType: "text/html", attempts: 2 });
});

test("an unmarked 503 remains a real failure instead of consuming the compile deadline", async () => {
  let attempts = 0;
  const result = await waitForAgentPreviewRoute(
    "https://relay.example/d/device-123/dev/",
    {},
    undefined,
    { intervalMs: 0, request: async () => { attempts += 1; return new Response(null, { status: 503 }); } },
  );
  assert.equal(attempts, 1);
  assert.deepEqual(result, { ok: false, status: 503, contentType: "unknown", attempts: 1 });
});

test("Stop interrupts the cold-start retry wait instead of waiting for its timer", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const resultPromise = waitForAgentPreviewRoute(
    "https://relay.example/d/device-123/dev/",
    {},
    () => controller.abort(),
    {
      intervalMs: 30_000,
      timeoutMs: 60_000,
      signal: controller.signal,
      request: async () => new Response(null, {
        status: 503,
        headers: { "x-yaver-devserver": "starting", "retry-after": "2" },
      }),
    },
  );

  const result = await resultPromise;
  assert.equal(result.error, "Dogfood launch stopped");
  assert.equal(result.attempts, 1);
  assert.ok(Date.now() - startedAt < 1_000, "Stop must not wait for the 30-second retry interval");
});
