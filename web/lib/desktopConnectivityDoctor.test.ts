import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const source = fs.readFileSync(path.join(process.cwd(), "components/dashboard/HealthView.tsx"), "utf8");
const devices = fs.readFileSync(path.join(process.cwd(), "components/dashboard/DevicesView.tsx"), "utf8");

test("desktop Health view exposes deterministic and OpenCode repair lanes", () => {
  assert.match(source, /Connectivity &amp; Remote Access/);
  assert.match(source, /applyConnectivityFix/);
  assert.match(source, /Fix with AI/);
  assert.match(source, /runner: "opencode"/);
  assert.match(source, /includeYaverMcp: true/);
});

test("Windows device details operation-probe and launch RDP through the desktop bridge", () => {
  assert.match(devices, /openSystemRemoteDesktop/);
  assert.match(devices, /Open RDP/);
  assert.match(devices, /Probing TCP 3389 over Tailscale/);
});

test("AI repair prompt preserves security consent boundaries", () => {
  assert.match(source, /Do not disable a firewall/);
  assert.match(source, /enable Microsoft RDP/);
  assert.match(source, /grant screen\/control permissions without asking/);
});
