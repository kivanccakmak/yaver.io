"use strict";

/**
 * Embedded yaver Go agent lifecycle for the desktop GUI.
 *
 * The desktop app is not just a client shell — it is a yaver node. It runs
 * the real Go agent (`yaver serve`) so the machine can be BOTH:
 *   - a remote box: vibed from any other surface (tvOS, mobile, web UI,
 *     another desktop app) over the same relay/mesh routing, and
 *   - a client surface: the window vibes directly against the local agent
 *     (or any other owned device) through the dashboard.
 *
 * Because the dashboard discovers devices via Convex (device rows + /d/<id>
 * proxy), no extra wiring is needed for the local agent to appear in the
 * device list — the agent's own heartbeat registers it, exactly like a
 * plain `yaver serve` machine.
 *
 * Lifecycle policy (adopt-or-spawn):
 *   1. Probe 127.0.0.1:18080/health (anonymous endpoint).
 *   2. Healthy → ADOPT the running agent (launchd/systemd/manual start).
 *      `yaver serve` itself already reuses a live process on the same port
 *      (main.go:2506-2516), so adopting matches the agent's own semantics.
 *   3. Not healthy → SPAWN `yaver serve --debug` as a foreground child so
 *      the GUI owns the lifecycle: health-wait, restart on crash, kill on
 *      quit. `--debug` keeps it in the foreground (main.go:2655-2669);
 *      without it the agent re-execs itself into the background, which the
 *      GUI cannot supervise.
 *
 * Binary resolution order (matches the CLI's agent-runtime.js):
 *   1. Bundled with the app  → <resources>/bin/yaver (electron-builder
 *      extraResources; the release workflow drops the platform binary here)
 *   2. CLI cache             → ~/.yaver/bin/current/<platform>/yaver
 *   3. PATH                  → `yaver`
 *
 * NO KEYCHAIN PROMPTS: the spawned agent runs with
 * YAVER_VAULT_SKIP_KEYCHAIN=1 (vault_keychain.go::vaultKeychainDisabled), so
 * it never shells out to the macOS `security` tool — the vault uses
 * ~/.yaver/master.key (the file IS the source of truth) and the OS-keychain
 * mirror is skipped entirely. A desktop app silently spawning "security
 * wants to use your confidential information" popups at boot is exactly the
 * unfalsifiable-keychain-prompt bug class this GUI must never ship.
 */

const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const AGENT_PORT = 18080;
const HEALTH_TIMEOUT_MS = 1500;
// The agent logs its first unconditional line and binds :18080 within a few
// seconds; give the health-wait room on cold starts (macOS Gatekeeper etc).
const HEALTH_WAIT_MS = 15000;

/**
 * Env for the spawned agent. YAVER_VAULT_SKIP_KEYCHAIN=1 disables the macOS
 * keychain mirror so `yaver serve` never triggers a keychain prompt — the
 * desktop GUI owns its own auth surface (the dashboard login) and must not
 * surprise the user with OS popups it did not originate.
 */
function agentEnv() {
  return {
    ...process.env,
    YAVER_VAULT_SKIP_KEYCHAIN: "1",
  };
}

/** Platform folder name used by the CLI cache: e.g. darwin-arm64. */
function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function binaryName() {
  return process.platform === "win32" ? "yaver.exe" : "yaver";
}

/** Probe the anonymous /health endpoint. Resolves {ok:boolean, body}. */
function probeAgentHealth(port = AGENT_PORT, timeoutMs = HEALTH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        let ok = false;
        try {
          ok = res.statusCode === 200 && JSON.parse(body).ok === true;
        } catch {
          ok = res.statusCode === 200;
        }
        resolve({ ok, body });
      });
    });
    req.on("error", () => resolve({ ok: false, body: "" }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, body: "" });
    });
  });
}

/**
 * Resolve the agent binary path, or null when no agent is available.
 * Resolution: bundled → CLI cache → PATH.
 */
function resolveAgentBinary() {
  // 1. Bundled with the packaged app (electron-builder extraResources).
  const bundled = (() => {
    try {
      const resources = process.resourcesPath;
      if (!resources) return null;
      const p = path.join(resources, "bin", binaryName());
      return fs.existsSync(p) ? p : null;
    } catch {
      return null;
    }
  })();
  if (bundled) return bundled;

  // 2. CLI cache — the versioned install the CLI's agent-runtime.js uses.
  const cache = (() => {
    try {
      const p = path.join(os.homedir(), ".yaver", "bin", "current", platformKey(), binaryName());
      return fs.existsSync(p) ? p : null;
    } catch {
      return null;
    }
  })();
  if (cache) return cache;

  // 3. PATH.
  const pathBin = (() => {
    try {
      const dirs = (process.env.PATH || "").split(path.delimiter);
      for (const dir of dirs) {
        if (!dir) continue;
        const p = path.join(dir, binaryName());
        try {
          fs.accessSync(p, fs.constants.X_OK);
          return p;
        } catch {
          /* keep looking */
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  })();
  return pathBin;
}

/**
 * AgentManager — adopt-or-spawn supervisor.
 * Events: "status" (state: starting|running|adopted|stopped|missing|crashed).
 */
class AgentManager {
  constructor({ port = AGENT_PORT, onStatus, onLog } = {}) {
    this.port = port;
    this.onStatus = onStatus || (() => {});
    this.onLog = onLog || (() => {});
    this.child = null;
    this.stopping = false;
    this.started = false;
    this.agentPath = null;
  }

  setStatus(state, detail) {
    this.onStatus({ state, port: this.port, agentPath: this.agentPath, detail: detail || null });
  }

  log(line) {
    if (typeof line === "string") this.onLog(line);
  }

  /**
   * Adopt a healthy running agent, else spawn one. Resolves with the final
   * state ("adopted" | "running" | "missing"). Spawn failure → "missing".
   */
  async start() {
    this.stopping = false;
    this.started = true;

    const health = await probeAgentHealth(this.port);
    if (health.ok) {
      this.agentPath = null; // adopted — not ours to kill
      this.setStatus("adopted");
      return "adopted";
    }

    const bin = resolveAgentBinary();
    if (!bin) {
      this.agentPath = null;
      this.setStatus("missing", "no yaver agent binary found (bundled, ~/.yaver/bin, or PATH)");
      return "missing";
    }
    this.agentPath = bin;

    const args = ["serve", "--debug"];
    // A non-default port must reach the agent (tests / coexisting instances).
    if (this.port !== AGENT_PORT) args.push("--port", String(this.port));
    const child = spawn(bin, args, {
      env: agentEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout.on("data", (d) => this.log(`[agent] ${d.toString().trimEnd()}`));
    child.stderr.on("data", (d) => this.log(`[agent] ${d.toString().trimEnd()}`));
    child.on("error", (err) => {
      this.log(`[agent] spawn error: ${err.message}`);
      if (!this.stopping) {
        this.child = null;
        this.setStatus("missing", `agent failed to start: ${err.message}`);
      }
    });
    child.on("exit", (code, signal) => {
      this.log(`[agent] exited code=${code} signal=${signal}`);
      if (this.stopping) return;
      this.child = null;
      if (!this.started) return; // never finished start — start() resolves below
      this.setStatus("crashed", `agent exited (code ${code}, signal ${signal})`);
      // Restart with backoff: crashes early in a boot storm shouldn't hammer.
      setTimeout(() => {
        if (this.stopping || this.child) return;
        this.setStatus("starting", "restarting after crash");
        void this.start();
      }, 3000);
    });

    // Wait for health; resolve "running" once the agent answers.
    const deadline = Date.now() + HEALTH_WAIT_MS;
    const poll = async () => {
      if (this.stopping) return "stopped";
      const h = await probeAgentHealth(this.port);
      if (h.ok) {
        this.setStatus("running");
        return "running";
      }
      if (Date.now() > deadline) {
        this.log("[agent] timed out waiting for health on :" + this.port);
        this.setStatus("crashed", "agent started but never answered /health");
        return "crashed";
      }
      return new Promise((res) => setTimeout(() => res(poll()), 500));
    };
    return poll();
  }

  /** Stop the child (only if we spawned it; adopted agents are left alone). */
  async stop() {
    this.stopping = true;
    this.started = false;
    if (this.child) {
      const child = this.child;
      this.child = null;
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
      // SIGKILL fallback after a grace period.
      setTimeout(() => {
        try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } catch { /* gone */ }
      }, 5000);
      this.setStatus("stopped");
    }
  }
}

module.exports = { AgentManager, resolveAgentBinary, probeAgentHealth, agentEnv, AGENT_PORT };
