"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { stripAuthFromUrl, applyAuthHeaders, applyKnownAuthHeaders } = require("../src/auth-interceptor");

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
  const out = stripAuthFromUrl("http://localhost:3000/dev/events?token=only&caller=web-dashboard");
  assert.equal(out.url, "http://localhost:3000/dev/events?caller=web-dashboard");
  assert.equal(out.token, "only");
  assert.equal(out.rp, null);
});

test("stripAuthFromUrl preserves application account tokens", () => {
  const url = "https://yaver.io/account/merge?token=merge-token";
  const out = stripAuthFromUrl(url);
  assert.equal(out.url, url);
  assert.equal(out.token, null);
  assert.equal(out.rp, null);
});

test("applyAuthHeaders strips + injects on first sight", () => {
  const authByOrigin = new Map();
  const { headers, url } = applyAuthHeaders({
    url: "https://agent.dev/stream?token=TOK&__rp=RP&caller=web-dashboard",
    headers: { "User-Agent": "x" },
    authByOrigin,
  });
  assert.equal(url, "https://agent.dev/stream?caller=web-dashboard");
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
    url: "http://x/stream?token=TOK&caller=web-dashboard",
    headers: { Authorization: "Bearer ALREADY" },
    authByOrigin,
  });
  assert.equal(headers["Authorization"], "Bearer ALREADY");
});

test("header injection treats lowercase names as already present", () => {
  const authByOrigin = new Map([["https://agent.dev", { token: "TOK", rp: "RP" }]]);
  const headers = applyKnownAuthHeaders({
    url: "https://agent.dev/events",
    headers: { authorization: "Bearer EXISTING", "x-relay-password": "EXISTING-RP" },
    authByOrigin,
  });
  assert.equal(headers.authorization, "Bearer EXISTING");
  assert.equal(headers["x-relay-password"], "EXISTING-RP");
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers["X-Relay-Password"], undefined);
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
