"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { stripAuthFromUrl, applyAuthHeaders } = require("../src/auth-interceptor");

test("stripAuthFromUrl removes token and __rp", () => {
  const out = stripAuthFromUrl("http://127.0.0.1:18080/dev/events?token=abc123&__rp=secret&caller=web-dashboard");
  assert.equal(out.url, "http://127.0.0.1:18080/dev/events?caller=web-dashboard");
  assert.equal(out.token, "abc123");
  assert.equal(out.rp, "secret");
});

test("stripAuthFromUrl leaves untouched URLs alone", () => {
  const out = stripAuthFromUrl("https://yaver.io/dashboard?tab=chat");
  assert.equal(out.url, "https://yaver.io/dashboard?tab=chat");
  assert.equal(out.token, null);
  assert.equal(out.rp, null);
});

test("stripAuthFromUrl handles missing params", () => {
  const out = stripAuthFromUrl("http://localhost:3000/dev/events?token=only");
  assert.equal(out.url, "http://localhost:3000/dev/events");
  assert.equal(out.token, "only");
  assert.equal(out.rp, null);
});

test("applyAuthHeaders strips + injects on first sight", () => {
  const authByOrigin = new Map();
  const { headers, url } = applyAuthHeaders({
    url: "https://agent.dev/stream?token=TOK&__rp=RP",
    headers: { "User-Agent": "x" },
    authByOrigin,
  });
  assert.equal(url, "https://agent.dev/stream");
  assert.equal(headers["Authorization"], "Bearer TOK");
  assert.equal(headers["X-Relay-Password"], "RP");
  assert.equal(headers["User-Agent"], "x");
});

test("applyAuthHeaders reuses captured material for later header-less URLs", () => {
  const authByOrigin = new Map();
  // First request carries the params; captures them per-origin.
  applyAuthHeaders({
    url: "http://10.0.0.5:18080/dev/events?token=TOK&__rp=RP",
    headers: {},
    authByOrigin,
  });
  // Follow-up stream to the same origin has no params (agent-client lazily
  // re-appends, but a second stream built before connect() would not).
  const second = applyAuthHeaders({
    url: "http://10.0.0.5:18080/vibing/preview/events",
    headers: {},
    authByOrigin,
  });
  assert.equal(second.headers["Authorization"], "Bearer TOK");
  assert.equal(second.headers["X-Relay-Password"], "RP");
  // ...and the URL still carries no token.
  assert.ok(!second.url.includes("token="));
});

test("applyAuthHeaders never overwrites an explicit Authorization header", () => {
  const authByOrigin = new Map();
  const { headers } = applyAuthHeaders({
    url: "http://x/stream?token=TOK",
    headers: { Authorization: "Bearer ALREADY" },
    authByOrigin,
  });
  assert.equal(headers["Authorization"], "Bearer ALREADY");
});

test("applyAuthHeaders does not leak secrets into origin-foreign requests", () => {
  const authByOrigin = new Map();
  applyAuthHeaders({
    url: "https://relay.yaver.io/p?token=TOK&__rp=RP",
    headers: {},
    authByOrigin,
  });
  const other = applyAuthHeaders({
    url: "https://example.com/plain",
    headers: {},
    authByOrigin,
  });
  assert.equal(other.headers["Authorization"], undefined);
  assert.equal(other.headers["X-Relay-Password"], undefined);
});
