#!/usr/bin/env node
// autorun.mjs — capability-aware WebRTC closed-loop matrix runner.
//
// Runs the same browser client against every remote-runtime target the agent
// says is enabled, records MP4 proof, and writes a machine-readable summary.
// Disabled targets are NAMED with the agent's reason instead of becoming silent
// gaps. Intended dogfood topology:
//
//   remote box: this Mac (Xcode simulators, local agent)
//   client:     Ubuntu 4GB Chromium over SSH
//
// Required:
//   YAVER_WEBRTC_BASE=http://<mac>:<port>
//   YAVER_WEBRTC_TOKEN=<agent token>
// Optional:
//   YAVER_WEBRTC_CLIENT_SSH=root@<ubuntu-tailscale-ip>
//   YAVER_WEBRTC_CLIENT_WORKDIR=/root/Workspace/sfmg
//   YAVER_CHROMIUM_PATH=/snap/bin/chromium
//   YAVER_RUNTIME_WORKDIR=/path/to/project/mobile
//   YAVER_RUNTIME_FRAMEWORK=react-native
//   YAVER_WEBRTC_AUTORUN_TARGETS=browser-window,ios-simulator,...
//   YAVER_WEBRTC_AUTORUN_RTP_BASE=http://<rtp-box>:<port>

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.YAVER_WEBRTC_BASE || "http://127.0.0.1:18080").replace(/\/$/, "");
const TOKEN = (process.env.YAVER_WEBRTC_TOKEN || "").trim() || tokenFromConfig();
const WORK_DIR = process.env.YAVER_RUNTIME_WORKDIR || process.cwd();
const FRAMEWORK = process.env.YAVER_RUNTIME_FRAMEWORK || "react-native";
const OUT = process.env.YAVER_OUT_DIR || `/tmp/yaver-webrtc-autorun-${Date.now()}`;
const CLIENT_SSH = (process.env.YAVER_WEBRTC_CLIENT_SSH || "").trim();
const CLIENT_WORKDIR = process.env.YAVER_WEBRTC_CLIENT_WORKDIR || "/tmp";
const CHROMIUM_PATH = process.env.YAVER_CHROMIUM_PATH || "";
const rawTargets = process.env.YAVER_WEBRTC_AUTORUN_TARGETS;
const TARGETS = rawTargets && rawTargets.trim().toLowerCase() === "none" ? [] : (rawTargets || [
  "browser-window",
  "ios-simulator",
  "ipados-simulator",
  "watchos-simulator",
  "tvos-simulator",
  "visionos-simulator",
  "android-emulator",
  "android-wear",
  "android-tv",
  "android-xr",
  "android-auto",
  "android-redroid",
  "android-device",
].join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const RTP_BASE = (process.env.YAVER_WEBRTC_AUTORUN_RTP_BASE || "").trim();
const TARGET_TIMEOUT_MS = Number(process.env.YAVER_WEBRTC_AUTORUN_TARGET_TIMEOUT_MS || 150_000);

if (!TOKEN) throw new Error("missing token; set YAVER_WEBRTC_TOKEN");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

function tokenFromConfig() {
  try {
    const cfg = JSON.parse(readFileSync(`${process.env.HOME}/.yaver/config.json`, "utf8"));
    return cfg.auth_token || cfg.token || "";
  } catch {
    return "";
  }
}

async function agent(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  return { res, body, text };
}

function run(cmd, args, opts = {}) {
  const printable = [cmd, ...args.map((a) => a.includes(TOKEN) ? "<token>" : a)].join(" ");
  console.log(`$ ${printable}`);
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeout || TARGET_TIMEOUT_MS,
    ...opts,
    env: { ...process.env, ...(opts.env || {}) },
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  return res;
}

function runWithInput(cmd, args, input, opts = {}) {
  const printable = [cmd, ...args.map((a) => a.includes(TOKEN) ? "<token>" : a)].join(" ");
  console.log(`$ ${printable} <stdin>`);
  const res = spawnSync(cmd, args, {
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeout || TARGET_TIMEOUT_MS,
    ...opts,
    env: { ...process.env, ...(opts.env || {}) },
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  return res;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function parseVerdict(stdout, fallbackLabel) {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const verdictLine = [...lines].reverse().find((line) => line.includes("VERDICT=")) || "";
  if (verdictLine.includes("VERDICT=PIXELS")) return { verdict: "PIXELS", detail: verdictLine };
  if (verdictLine.includes("VERDICT=NAMED")) return { verdict: "NAMED", detail: verdictLine };
  if (verdictLine.includes("VERDICT=SILENT")) return { verdict: "SILENT", detail: verdictLine };
  if (verdictLine.includes("VERDICT=FAIL")) return { verdict: "SILENT", detail: verdictLine };
  return { verdict: "SILENT", detail: `no verdict line for ${fallbackLabel}` };
}

function parseRunResult(res, label) {
  const parsed = parseVerdict(res.stdout || "", label);
  if (parsed.detail && !parsed.detail.startsWith("no verdict line")) return parsed;
  if (res.error?.code === "ETIMEDOUT") {
    return { verdict: "SILENT", detail: `target timed out after ${TARGET_TIMEOUT_MS}ms: ${label}` };
  }
  return parsed;
}

function copyHarnessToClient() {
  if (!CLIENT_SSH) return;
  run("ssh", [CLIENT_SSH, `mkdir -p ${shellQuote(CLIENT_WORKDIR)}`]);
  run("scp", [
    join(HERE, "remote-runtime.mjs"),
    join(HERE, "run.mjs"),
    join(HERE, "receiver.html"),
    `${CLIENT_SSH}:${CLIENT_WORKDIR}/`,
  ]);
}

function runClientNode(script, args, env, label) {
  if (!CLIENT_SSH) {
    return run("node", [join(HERE, script), ...args], {
      cwd: HERE,
      env,
    });
  }
  const assignments = Object.entries(env)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(" ");
  const command = `cd ${shellQuote(CLIENT_WORKDIR)} && ${assignments} node ./${script} ${args.map(shellQuote).join(" ")}`;
  return runWithInput("ssh", [CLIENT_SSH, "sh", "-s"], command, { env: { YAVER_WEBRTC_TOKEN: "" }, label });
}

async function startBrowserLogServer() {
  const html = `<!doctype html><meta charset=utf-8><title>Yaver WebRTC log probe</title>
<style>html,body{margin:0;height:100%;background:#102033;color:#f6f7f8;font:24px system-ui;display:grid;place-items:center}</style>
<main>browser-log closed loop</main>
<script>
console.log("yaver-log-ok", {lane:"browser-window"});
console.error("yaver-error-ok");
setTimeout(function(){ throw new Error("yaver-throw-ok"); }, 100);
</script>`;
  const code = `
    const http = require("node:http");
    const html = ${JSON.stringify(html)};
    const server = http.createServer((_, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      console.log(server.address().port);
    });
  `;
  const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("browser log server did not start")), 10_000);
    child.stdout.on("data", (chunk) => {
      buf += String(chunk);
      const line = buf.split(/\r?\n/).find(Boolean);
      if (!line) return;
      clearTimeout(timer);
      resolve(Number(line));
    });
    child.on("exit", (code) => reject(new Error(`browser log server exited early: ${code}`)));
  });
  return {
    address: () => ({ port }),
    close: () => child.kill("SIGTERM"),
  };
}

async function capabilities() {
  const q = new URLSearchParams({ workDir: WORK_DIR, framework: FRAMEWORK, refresh: "1" });
  const got = await agent(`/remote-runtime/capabilities?${q.toString()}`);
  if (!got.res.ok) throw new Error(`capabilities HTTP ${got.res.status}: ${got.text.slice(0, 240)}`);
  const targets = got.body?.targets || got.body?.runtimeTargets || [];
  const byID = new Map();
  for (const t of targets) byID.set(t.id, t);
  return byID;
}

async function cleanupSessionsForTarget(targetID) {
  const got = await agent("/remote-runtime/sessions").catch(() => null);
  const sessions = got?.body?.sessions ?? got?.body ?? [];
  if (!Array.isArray(sessions)) return;
  for (const s of sessions) {
    if (s?.targetId === targetID || s?.targetID === targetID) {
      await agent(`/remote-runtime/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" }).catch(() => null);
    }
  }
}

function collectClientOut(path) {
  if (!CLIENT_SSH) return;
  mkdirSync(OUT, { recursive: true });
  run("scp", ["-r", `${CLIENT_SSH}:${path}`, `${OUT}/`], { timeout: 60_000 });
}

async function main() {
  console.log(`webrtc-autorun · base=${BASE} · client=${CLIENT_SSH || "local"} · workDir=${WORK_DIR}`);
  copyHarnessToClient();
  const caps = await capabilities();
  writeFileSync(join(OUT, "capabilities.json"), JSON.stringify(Object.fromEntries(caps), null, 2));

  const results = [];
  const logServer = await startBrowserLogServer();
  try {
    for (const target of TARGETS) {
      const cap = caps.get(target);
      if (!cap) {
        results.push({ id: target, verdict: "NAMED", detail: "target not advertised by capabilities" });
        console.log(`[${target}] NAMED · target not advertised by capabilities`);
        continue;
      }
      if (cap.enabled === false) {
        const detail = cap.reason || cap.note || "target disabled by capability probe";
        results.push({ id: target, verdict: "NAMED", detail });
        console.log(`[${target}] NAMED · ${detail}`);
        continue;
      }

      const targetOut = `${OUT}/${target}`;
      const env = {
        YAVER_WEBRTC_BASE: BASE,
        YAVER_WEBRTC_TOKEN: TOKEN,
        YAVER_CHROMIUM_PATH: CHROMIUM_PATH,
        YAVER_RUNTIME_WORKDIR: WORK_DIR,
        YAVER_RUNTIME_FRAMEWORK: FRAMEWORK,
        YAVER_WEBRTC_RECORD_DWELL_MS: process.env.YAVER_WEBRTC_RECORD_DWELL_MS || "3000",
        YAVER_OUT_DIR: targetOut,
      };
      if (target === "browser-window") {
        const port = logServer.address().port;
        env.YAVER_RUNTIME_CONTROL_NAVIGATE_URL = `http://127.0.0.1:${port}/`;
        env.YAVER_RUNTIME_EXPECT_BROWSER_LOGS = "yaver-log-ok,yaver-error-ok,yaver-throw-ok";
      }
      const res = runClientNode("remote-runtime.mjs", [target], env, target);
      collectClientOut(targetOut);
      await cleanupSessionsForTarget(target);
      const parsed = parseRunResult(res, target);
      results.push({ id: target, ...parsed, status: res.status ?? 1, signal: res.signal || "" });
    }
  } finally {
    logServer.close();
  }

  if (RTP_BASE) {
    const rtpOut = `${OUT}/rtp-browser-lanes`;
    const res = runClientNode("run.mjs", ["both"], {
      YAVER_WEBRTC_BASE: RTP_BASE.replace(/\/$/, ""),
      YAVER_WEBRTC_TOKEN: TOKEN,
      YAVER_CHROMIUM_PATH: CHROMIUM_PATH,
      YAVER_WEBRTC_RECORD_DWELL_MS: process.env.YAVER_WEBRTC_RECORD_DWELL_MS || "3000",
      YAVER_OUT_DIR: rtpOut,
    }, "rtp-browser-lanes");
    collectClientOut(rtpOut);
    results.push({ id: "rtp-browser-lanes", ...parseRunResult(res, "rtp-browser-lanes"), status: res.status ?? 1, signal: res.signal || "" });
  }

  const sessions = await agent("/remote-runtime/sessions").catch((e) => ({ res: { ok: false, status: 0 }, text: String(e), body: null }));
  const liveSessions = sessions.body?.sessions ?? sessions.body ?? [];
  results.push({
    id: "session-cleanup",
    verdict: Array.isArray(liveSessions) && liveSessions.length === 0 ? "PIXELS" : "SILENT",
    detail: Array.isArray(liveSessions) ? `${liveSessions.length} live sessions after run` : `could not inspect sessions: ${sessions.text || sessions.res.status}`,
  });

  writeFileSync(join(OUT, "summary.json"), JSON.stringify({ base: BASE, client: CLIENT_SSH || "local", workDir: WORK_DIR, results }, null, 2));
  const failures = results.filter((r) => r.verdict === "SILENT");
  const named = results.filter((r) => r.verdict === "NAMED");
  const pixels = results.filter((r) => r.verdict === "PIXELS");
  console.log(`SUMMARY pixels=${pixels.length} named=${named.length} silent=${failures.length} out=${OUT}`);
  for (const r of results) console.log(`${r.verdict} · ${r.id} · ${r.detail}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`fatal: ${e?.message || e}`);
  process.exit(2);
});
