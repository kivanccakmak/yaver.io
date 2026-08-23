import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./quic.ts", import.meta.url), "utf8");
const contextSource = readFileSync(new URL("../context/DeviceContext.tsx", import.meta.url), "utf8");

test("fresh relay settings repair a cached active path for iframe auth", () => {
  const setter = source.slice(source.indexOf("setRelayServers("), source.indexOf("getRelayServers()"));
  assert.match(setter, /if \(this\.activeRelayUrl\)/);
  assert.match(setter, /if \(active\?\.password\) this\.activeRelayPassword = active\.password/);
});

test("browser preview URLs use the reconciled relay credential", () => {
  const start = source.indexOf("getDevServerBundleUrl(");
  const end = source.indexOf("// ── Container Sandbox", start);
  const method = source.slice(start, end);
  assert.match(method, /const relayPassword = this\.resolvedRelayPasswordForUrl\(url\)/);
  assert.match(method, /__rp=\$\{encodeURIComponent\(relayPassword\)\}/);
  assert.doesNotMatch(method, /this\.activeRelayPassword\)/);
});

test("relay query auth follows a known relay proxy URL before active state hydrates", () => {
  const start = source.indexOf("resolvedRelayPasswordForUrl(");
  const end = source.indexOf("/** Set Cloudflare Tunnel endpoints", start);
  const method = source.slice(start, end);
  assert.match(method, /new globalThis\.URL\(targetUrl\)/);
  assert.match(method, /target\.origin === relayUrl\.origin/);
  assert.match(method, /target\.pathname\.startsWith\(proxyPrefix\)/);
  assert.match(method, /if \(!relay\.password\) continue/);
  assert.match(method, /this\._tunnelHeaders\["X-Relay-Password"\]/);
  assert.match(method, /target\.origin === base\.origin/);
  assert.match(method, /basePath\.endsWith\(deviceProxy\)/);
  assert.match(method, /target\.pathname\.startsWith\(`\$\{basePath\}\/`\)/);
});

test("relay discovery merges the device-local credential before publishing clients", () => {
  assert.match(contextSource, /getLocalSecret\(LOCAL_KEYS\.relayPassword\)/);
  assert.match(contextSource, /settingsRelayPassword = settings\.relayPassword \|\| settingsRelayPassword/);
  assert.match(contextSource, /resolveRelayServers\(platformServers, settingsRelayUrl, settingsRelayPassword\)/);
});
