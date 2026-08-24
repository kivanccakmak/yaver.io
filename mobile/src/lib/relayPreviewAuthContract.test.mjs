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

test("browser preview URLs never carry owner or relay credentials", () => {
  const start = source.indexOf("getDevServerBundleUrl(");
  const end = source.indexOf("// ── Container Sandbox", start);
  const method = source.slice(start, end);
  assert.match(method, /return `\$\{this\.baseUrl\}\$\{bundlePath\}`/);
  assert.doesNotMatch(method, /token=|__rp|relayPassword|this\.token/);
});

test("every real mobile browser-preview surface authenticates the initial WebView request with headers", () => {
  const files = [
    new URL("../components/DevPreview.tsx", import.meta.url),
    new URL("../../app/(tabs)/apps.tsx", import.meta.url),
    new URL("../../app/(tabs)/project.tsx", import.meta.url),
  ];
  for (const file of files) {
    const body = readFileSync(file, "utf8");
    assert.match(body, /source=\{\{ uri: (?:bundleUrl|renderUrl), headers: [^}]+\.getAuthHeaders\(\) \}\}/,
      `${file.pathname} must seed the relay's scoped HttpOnly cookie without URL credentials`);
  }
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
