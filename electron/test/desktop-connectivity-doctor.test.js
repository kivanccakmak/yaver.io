"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseTailscaleStatus,
  privateAddressSummary,
  runDesktopConnectivityDiagnostics,
  tailscaleCandidates,
  unixFirewallCheck,
  windowsFirewallRepairScript,
  windowsFirewallStatusScript,
} = require("../src/desktop-connectivity-doctor");

test("private address summary separates LAN from Tailscale candidates", () => {
  assert.deepEqual(privateAddressSummary({
    lan: [{ family: "IPv4", internal: false, address: "192.168.1.20" }],
    tail: [{ family: "IPv4", internal: false, address: "100.101.1.20" }],
    public: [{ family: "IPv4", internal: false, address: "203.0.113.20" }],
  }), { lan: 1, tailnet: 1 });
});

test("Linux firewall diagnostics name active filtering without inventing a broad fix", async () => {
  const posture = await unixFirewallCheck("linux", async (file) => (
    file === "ufw"
      ? { ok: true, stdout: "Status: active", stderr: "", error: "" }
      : { ok: false, stdout: "", stderr: "", error: "missing" }
  ));
  assert.equal(posture.status, "warn");
  assert.match(posture.detail, /operation-probe/);
  assert.equal(posture.fix, undefined);
});

test("Tailscale status requires a running backend and an address", () => {
  assert.equal(parseTailscaleStatus(JSON.stringify({ BackendState: "Running", Self: { Online: true, TailscaleIPs: ["100.64.0.1"] } })).online, true);
  assert.equal(parseTailscaleStatus(JSON.stringify({ BackendState: "NeedsLogin", Self: { Online: true, TailscaleIPs: ["100.64.0.1"] } })).online, false);
});

test("Windows GUI install path is discoverable outside PATH", () => {
  const candidates = tailscaleCandidates("win32", { ProgramFiles: "C:\\Program Files" });
  assert.equal(candidates[0], "C:\\Program Files\\Tailscale\\tailscale.exe");
});

test("firewall repair is program-scoped, private-only, and never opens RDP", () => {
  const script = windowsFirewallRepairScript("C:\\Program Files\\Yaver\\yaver.exe");
  assert.match(script, /-Program \$agent/);
  assert.match(script, /-Profile Private,Domain/);
  assert.match(script, /-RemoteAddress LocalSubnet,100\.64\.0\.0\/10/);
  assert.match(script, /-LocalPort 18080,18443/);
  assert.match(script, /-LocalPort 4433/);
  assert.doesNotMatch(script, /-Profile (?:Any|Public)/);
  assert.doesNotMatch(script, /3389/);
});

test("firewall pass probe verifies executable, ports, profiles, and source scope", () => {
  const script = windowsFirewallStatusScript("C:\\Program Files\\Yaver\\yaver.exe");
  assert.match(script, /Get-NetFirewallApplicationFilter/);
  assert.match(script, /Get-NetFirewallPortFilter/);
  assert.match(script, /Get-NetFirewallAddressFilter/);
  assert.match(script, /programOK/);
  assert.match(script, /portsOK/);
  assert.match(script, /scopeOK/);
  assert.match(script, /public\.Count -eq 0/);
});

test("desktop report names a stale Tailscale inventory and offers recovery", async () => {
  const fakeRun = async (file) => {
    if (String(file).toLowerCase().includes("tailscale")) {
      return { ok: true, stdout: JSON.stringify({ BackendState: "NeedsLogin", Self: { Online: true, TailscaleIPs: ["100.64.0.1"] } }), stderr: "", error: "" };
    }
    return { ok: false, stdout: "", stderr: "", error: "not found" };
  };
  const report = await runDesktopConnectivityDiagnostics({
    platform: "linux",
    agentStatus: "running",
    localDeviceId: "dev-1",
    probeAgent: async () => ({ ok: true }),
    interfaces: { lan: [{ family: "IPv4", internal: false, address: "192.168.1.2" }] },
    run: fakeRun,
  });
  const tailscale = report.checks.find((check) => check.id === "tailscale");
  assert.equal(tailscale.status, "warn");
  assert.match(tailscale.detail, /NeedsLogin/);
  assert.equal(tailscale.fix.id, "open-tailscale");
});
