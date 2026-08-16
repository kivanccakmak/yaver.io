"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { AgentManager, resolveAgentBinary, probeAgentHealth, agentEnv, AGENT_PORT } = require("../src/agent-manager");

test("AGENT_PORT is 18080 (matches the agent's default)", () => {
  assert.equal(AGENT_PORT, 18080);
});

// The desktop GUI must NEVER trigger a macOS keychain prompt. The agent is
// spawned with YAVER_VAULT_SKIP_KEYCHAIN=1, which the agent honors as a
// global keychain gate (vault_keychain.go::keychainAccessDisabled) for both
// the vault mirror AND the runner-auth probe — the two `security` shell-outs
// that prompt. Pin the env so the gate can't silently regress.
test("agentEnv always sets YAVER_VAULT_SKIP_KEYCHAIN=1", () => {
  const env = agentEnv();
  assert.equal(env.YAVER_VAULT_SKIP_KEYCHAIN, "1");
  // And it must be inherited through to the spawned child, not dropped.
  const old = process.env.YAVER_VAULT_SKIP_KEYCHAIN;
  try {
    delete process.env.YAVER_VAULT_SKIP_KEYCHAIN;
    const env2 = agentEnv();
    assert.equal(env2.YAVER_VAULT_SKIP_KEYCHAIN, "1");
  } finally {
    if (old === undefined) delete process.env.YAVER_VAULT_SKIP_KEYCHAIN;
    else process.env.YAVER_VAULT_SKIP_KEYCHAIN = old;
  }
});

test("probeAgentHealth resolves ok=false on an unbound port", async () => {
  // Bind a port, grab it, close it, then probe — guarantees nothing listens.
  const srv = http.createServer();
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  const port = srv.address().port;
  await new Promise((res) => srv.close(res));
  const h = await probeAgentHealth(port, 500);
  assert.equal(h.ok, false);
});

test("probeAgentHealth resolves ok=true on a healthy /health endpoint", async () => {
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, lifecycle: { state: "ready-to-connect" } }));
  });
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  const port = srv.address().port;
  try {
    const h = await probeAgentHealth(port, 1000);
    assert.equal(h.ok, true);
  } finally {
    await new Promise((res) => srv.close(res));
  }
});

test("probeAgentHealth treats non-ok JSON as unhealthy", async () => {
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "missing auth" }));
  });
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  const port = srv.address().port;
  try {
    const h = await probeAgentHealth(port, 1000);
    assert.equal(h.ok, false);
  } finally {
    await new Promise((res) => srv.close(res));
  }
});

test("resolveAgentBinary returns null when nothing is available", () => {
  // PATH is scrubbed to empty and the CLI cache is pointed at a temp dir that
  // does not exist, so every resolution layer must come up empty.
  const oldPath = process.env.PATH;
  const oldHome = process.env.HOME;
  const oldResources = process.resourcesPath;
  try {
    delete process.env.PATH;
    process.env.HOME = "/nonexistent-yaver-test-home-xyz";
    delete process.resourcesPath;
    assert.equal(resolveAgentBinary(), null);
  } finally {
    process.env.PATH = oldPath;
    process.env.HOME = oldHome;
    if (oldResources === undefined) delete process.resourcesPath;
    else process.resourcesPath = oldResources;
  }
});

test("AgentManager adopts a healthy running agent without spawning", async () => {
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: "test" }));
  });
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  const port = srv.address().port;
  const statuses = [];
  const mgr = new AgentManager({ port, onStatus: (s) => statuses.push(s.state) });
  try {
    const result = await mgr.start();
    assert.equal(result, "adopted");
    assert.deepEqual(statuses, ["adopted"]);
    assert.equal(mgr.child, null); // adopted — nothing of ours to kill
  } finally {
    await new Promise((res) => srv.close(res));
  }
});

test("AgentManager reports 'missing' when no binary and nothing is listening", async () => {
  // Reserve + free a port so nothing listens on it.
  const srv = http.createServer();
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  const port = srv.address().port;
  await new Promise((res) => srv.close(res));

  const oldPath = process.env.PATH;
  const oldHome = process.env.HOME;
  const oldResources = process.resourcesPath;
  const statuses = [];
  const mgr = new AgentManager({ port, onStatus: (s) => statuses.push(s.state) });
  try {
    delete process.env.PATH;
    process.env.HOME = "/nonexistent-yaver-test-home-xyz";
    delete process.resourcesPath;
    const result = await mgr.start();
    assert.equal(result, "missing");
    assert.ok(statuses.includes("missing"));
  } finally {
    process.env.PATH = oldPath;
    process.env.HOME = oldHome;
    if (oldResources === undefined) delete process.resourcesPath;
    else process.resourcesPath = oldResources;
    await mgr.stop();
  }
});
