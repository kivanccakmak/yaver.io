"use strict";

/**
 * Pure URL auth-stripping + header-injection helpers for the Electron GUI.
 * Split out of main.js so the token-in-URL fix is unit-testable.
 *
 * The web dashboard passes ?token=/?__rp= on SSE URLs because EventSource
 * cannot set headers (web/lib/agent-client.ts:6135-6164). The GUI strips them
 * and re-injects as Authorization / X-Relay-Password headers — both accepted
 * by the agent's CORS allowlist (desktop/agent/httpserver.go:3231).
 */

/**
 * Remove `token` and `__rp` query params from a URL.
 * Returns { url, token, rp } — token/rp are the stripped secrets (or null).
 */
function stripAuthFromUrl(urlString) {
  const u = new URL(urlString);
  const rp = u.searchParams.get("__rp");
  // `token` is also a legitimate application parameter (for example
  // /account/merge?token=...). AgentClient marks its native EventSource URLs
  // with caller=web-dashboard, and Relay Pro URLs carry __rp. Never strip a
  // generic app/OAuth/reset token merely because it shares the same name.
  const isAgentAuth = Boolean(rp) || u.searchParams.get("caller") === "web-dashboard";
  const token = isAgentAuth ? u.searchParams.get("token") : null;
  if (token || rp) {
    if (token) u.searchParams.delete("token");
    if (rp) u.searchParams.delete("__rp");
    return { url: u.toString(), token, rp };
  }
  return { url: urlString, token: null, rp: null };
}

/**
 * Build the outgoing headers for a request, applying per-origin captured
 * auth material. `capture` mutates the per-origin map when the request URL
 * carries auth params (so follow-up streams to the same agent get headers
 * even when their URL has no params).
 *
 * Returns { headers, url } — url differs from the input when auth params
 * were stripped.
 */
function applyAuthHeaders({ url: urlString, headers, authByOrigin }) {
  let url = urlString;
  let token = null;
  let rp = null;
  try {
    const stripped = stripAuthFromUrl(url);
    url = stripped.url;
    token = stripped.token;
    rp = stripped.rp;
  } catch {
    return { headers: { ...headers }, url: urlString };
  }

  const next = { ...headers };
  let origin = null;
  try {
    origin = new URL(url).origin;
  } catch {
    /* keep going without origin-scoped capture */
  }

  if (origin) {
    const entry = authByOrigin.get(origin) || {};
    if (token) entry.token = token;
    if (rp) entry.rp = rp;
    authByOrigin.set(origin, entry);
  }

  return { headers: applyKnownAuthHeaders({ url, headers: next, authByOrigin }), url };

}

function hasHeader(headers, name) {
  const needle = name.toLowerCase();
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === needle);
}

/** Header-only half used from Electron's onBeforeSendHeaders callback. */
function applyKnownAuthHeaders({ url, headers, authByOrigin }) {
  const next = { ...headers };
  let origin = null;
  try {
    origin = new URL(url).origin;
  } catch {
    return next;
  }
  const known = authByOrigin.get(origin);
  if (known && known.token && !hasHeader(next, "Authorization")) {
    next.Authorization = `Bearer ${known.token}`;
  }
  if (known && known.rp && !hasHeader(next, "X-Relay-Password")) {
    next["X-Relay-Password"] = known.rp;
  }

  return next;
}

module.exports = { stripAuthFromUrl, applyAuthHeaders, applyKnownAuthHeaders, hasHeader };
