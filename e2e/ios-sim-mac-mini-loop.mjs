#!/usr/bin/env node
/**
 * Closed-loop check: this Mac's iOS Simulator + the user's remote Mac mini.
 *
 * The simulator leg proves the native Yaver shell boots and can land on the
 * Projects route. The remote leg then exercises the same project inventory /
 * action / optional dev-start surfaces the Projects tab uses against a real
 * Mac mini agent. Keep the target matrix data-only; the script must not bake a
 * private home directory or bearer token into the repo.
 *
 * Required:
 *   YAVER_AGENT_URL=http://host:18080
 *   YAVER_AGENT_TOKEN=...  (or TOKEN_FILE=/path/to/token)
 *
 * Useful:
 *   node e2e/ios-sim-mac-mini-loop.mjs --app /path/to/Yaver.app
 *   node e2e/ios-sim-mac-mini-loop.mjs --build
 *   node e2e/ios-sim-mac-mini-loop.mjs --start-preview
 */
import { execFile as execFileCb, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const MATRIX_FILE = join(__dirname, "mobile-project-matrix.json");
const OUT_DIR = process.env.OUT_DIR || "/tmp/yaver-ios-sim-loop";
const BUNDLE_ID = process.env.YAVER_IOS_BUNDLE_ID || "io.yaver.mobile";
const DEFAULT_SIM_NAME = process.env.IOS_SIMULATOR_NAME || "iPhone 17 Pro";
const AGENT_URL = (process.env.YAVER_AGENT_URL || process.env.AGENT_URL || "").replace(/\/+$/, "");
let TOKEN = (process.env.YAVER_AGENT_TOKEN || readTokenFile()).trim();
const CONVEX_SITE_URL = (process.env.CONVEX_SITE_URL || "https://perceptive-minnow-557.eu-west-1.convex.site").replace(/\/+$/, "");

const args = new Set(process.argv.slice(2));
const argValue = (name) => {
  const prefix = `${name}=`;
  const hit = process.argv.slice(2).find((v) => v.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : "";
};

const APP_PATH_ARG = argValue("--app");
const BUILD = args.has("--build");
const START_PREVIEW = args.has("--start-preview");
const SKIP_SIM = args.has("--skip-simulator");
const SKIP_REFRESH = args.has("--skip-refresh");
const SIM_NAME = argValue("--sim") || DEFAULT_SIM_NAME;
const BOOT_BUDGET_MS = Number(process.env.BOOT_BUDGET_MS || 240_000);
const MATRIX = JSON.parse(readFileSync(MATRIX_FILE, "utf8"));

function readTokenFile() {
  const file = process.env.TOKEN_FILE;
  if (!file) return "";
  try { return readFileSync(file, "utf8"); } catch { return ""; }
}

function sh(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = execFileCb(cmd, args, {
      cwd: opts.cwd || REPO,
      timeout: opts.timeout || 120_000,
      maxBuffer: opts.maxBuffer || 10 * 1024 * 1024,
      env: { ...process.env, ...(opts.env || {}) },
    }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
    if (opts.inherit) {
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);
    }
  });
}

async function agent(path, init = {}) {
  if (!AGENT_URL) throw new Error("YAVER_AGENT_URL is required");
  if (!TOKEN) TOKEN = await mintTokenFromCredentials();
  if (!TOKEN) throw new Error("YAVER_AGENT_TOKEN/TOKEN_FILE is required, or set YAVER_EMAIL + YAVER_PASSWORD for a local run");
  const res = await fetch(`${AGENT_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, json, text };
}

async function mintTokenFromCredentials() {
  const email = process.env.YAVER_EMAIL || "";
  const password = process.env.YAVER_PASSWORD || "";
  if (!email || !password) return "";
  const res = await fetch(`${CONVEX_SITE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`credential login failed: ${data?.error || `HTTP ${res.status}`}`);
  if (data?.requires2fa) throw new Error("credential login requires 2FA; pass YAVER_AGENT_TOKEN/TOKEN_FILE instead");
  return typeof data?.token === "string" ? data.token : "";
}

function normalize(v) {
  return String(v || "").toLowerCase().trim();
}

function frameworkSet(project) {
  const vals = [
    project.framework,
    project.stack,
    ...(Array.isArray(project.frameworks) ? project.frameworks : []),
    ...(Array.isArray(project.stacks) ? project.stacks : []),
    ...(Array.isArray(project.tags) ? project.tags : []),
  ];
  return new Set(vals.map(normalize).filter(Boolean));
}

function frameworkMatches(project, wanted) {
  const got = frameworkSet(project);
  for (const fw of wanted.map(normalize)) {
    if (got.has(fw)) return true;
    if (fw === "ios" && got.has("swift")) return true;
    if (fw === "android" && got.has("kotlin")) return true;
    if (fw === "react-native" && got.has("expo")) return true;
    if (fw === "expo" && got.has("react-native")) return true;
  }
  return false;
}

function projectMatches(project, target) {
  const nameNeedle = normalize(target.match?.name);
  const pathSuffix = target.match?.pathSuffix || "";
  const name = normalize(project.name);
  const path = String(project.path || "");
  if (nameNeedle && !name.includes(nameNeedle)) return false;
  if (pathSuffix && !path.endsWith(pathSuffix)) return false;
  if (target.frameworks?.length && !frameworkMatches(project, target.frameworks)) return false;
  return true;
}

function pickProject(projects, target) {
  const direct = projects.find((p) => projectMatches(p, target));
  if (direct) return direct;
  if (target.match?.pathSuffix) return null;
  const loose = projects.find((p) => {
    const nameNeedle = normalize(target.match?.name);
    return nameNeedle && normalize(p.name).includes(nameNeedle) && frameworkMatches(p, target.frameworks || []);
  });
  return loose || null;
}

async function findSimulator() {
  const { stdout } = await sh("xcrun", ["simctl", "list", "devices", "available", "--json"]);
  const data = JSON.parse(stdout);
  const all = Object.values(data.devices || {}).flat();
  const named = all.find((d) => d.name === SIM_NAME) || all.find((d) => /iPhone/.test(d.name));
  if (!named) throw new Error(`No available iPhone simulator found (wanted ${SIM_NAME})`);
  return named;
}

async function bootSimulator(udid) {
  await sh("xcrun", ["simctl", "boot", udid], { timeout: 180_000 }).catch((err) => {
    const msg = `${err.stderr || ""}${err.stdout || ""}`;
    if (!/Unable to boot device in current state|Booted/i.test(msg)) throw err;
  });
  await sh("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeout: 180_000, inherit: true });
}

async function buildApp() {
  console.log("building iOS simulator app with xcodebuild");
  await sh("xcodebuild", [
    "-workspace", "Yaver.xcworkspace",
    "-scheme", "Yaver",
    "-configuration", "Debug",
    "-destination", `platform=iOS Simulator,name=${SIM_NAME}`,
    "build",
  ], { cwd: join(REPO, "mobile/ios"), timeout: 30 * 60_000, inherit: true, maxBuffer: 50 * 1024 * 1024 });
}

async function resolveAppPath() {
  if (APP_PATH_ARG) return resolve(APP_PATH_ARG);
  const local = join(REPO, "mobile/ios/build/Build/Products/Debug-iphonesimulator/Yaver.app");
  if (existsSync(local)) return local;
  const { stdout } = await sh("bash", ["-lc", "find ~/Library/Developer/Xcode/DerivedData -path '*/Build/Products/Debug-iphonesimulator/Yaver.app' -type d -print 2>/dev/null | tail -1"], { timeout: 60_000 });
  return stdout.trim();
}

async function launchSimulatorApp(udid, appPath) {
  if (!appPath || !existsSync(appPath)) {
    throw new Error(`Yaver.app not found. Pass --app /path/to/Yaver.app or rerun with --build.`);
  }
  await sh("xcrun", ["simctl", "install", udid, appPath], { timeout: 180_000, inherit: true });
  await sh("xcrun", ["simctl", "launch", "--terminate-running-process", udid, BUNDLE_ID], { timeout: 120_000, inherit: true });
  await new Promise((r) => setTimeout(r, 5000));
  await sh("xcrun", ["simctl", "openurl", udid, "yaver:///(tabs)/apps"], { timeout: 60_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 5000));
}

function startSimulatorLog(udid) {
  const out = join(OUT_DIR, "ios-simulator.log");
  const child = spawn("xcrun", [
    "simctl", "spawn", udid, "log", "stream",
    "--style", "compact",
    "--level", "debug",
    "--predicate", `process == "Yaver" OR eventMessage CONTAINS[c] "Yaver" OR eventMessage CONTAINS[c] "expo"`,
  ], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  const collect = (buf) => {
    chunks.push(buf);
    if (chunks.reduce((n, b) => n + b.length, 0) > 2_000_000) chunks.shift();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  return {
    stop() {
      child.kill("SIGTERM");
      writeFileSync(out, Buffer.concat(chunks).toString("utf8"));
      return out;
    },
  };
}

async function screenshot(udid, name) {
  const file = join(OUT_DIR, `${name}.png`);
  await sh("xcrun", ["simctl", "io", udid, "screenshot", file], { timeout: 60_000 });
  return file;
}

async function simulatorLoop() {
  if (SKIP_SIM) return { skipped: true };
  const sim = await findSimulator();
  console.log(`simulator: ${sim.name} (${sim.udid})`);
  await bootSimulator(sim.udid);
  if (BUILD) await buildApp();
  const appPath = await resolveAppPath();
  await launchSimulatorApp(sim.udid, appPath);
  const before = await screenshot(sim.udid, "ios-projects-route");
  return { udid: sim.udid, name: sim.name, appPath, screenshot: before };
}

async function waitForMobileProjects() {
  if (!SKIP_REFRESH) {
    const refresh = await agent("/projects/mobile", { method: "POST", body: "{}" });
    if (!refresh.ok) throw new Error(`/projects/mobile refresh failed: HTTP ${refresh.status} ${refresh.text.slice(0, 180)}`);
  }

  const deadline = Date.now() + Number(process.env.PROJECT_SCAN_BUDGET_MS || 180_000);
  let last = null;
  while (Date.now() < deadline) {
    const mobile = await agent("/projects/mobile");
    if (!mobile.ok) throw new Error(`/projects/mobile failed: HTTP ${mobile.status} ${mobile.text.slice(0, 180)}`);
    last = mobile.json || {};
    const projects = Array.isArray(last.projects) ? last.projects : [];
    if (!last.scanning || projects.length > 0) return last;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return last || { projects: [] };
}

async function getAllProjectRows() {
  const [mobile, general] = await Promise.all([
    waitForMobileProjects(),
    agent("/projects").then((r) => r.json || { projects: [] }),
  ]);
  const seen = new Set();
  const merged = [];
  for (const p of [...(mobile.projects || []), ...(general.projects || [])]) {
    const key = `${p.path || ""}\0${p.name || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(p);
  }
  return { mobile, general, merged };
}

async function checkActions(project) {
  if (!project?.path) return { ok: false, detail: "matched project has no path" };
  const res = await agent(`/projects/actions?path=${encodeURIComponent(project.path)}`);
  if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${res.text.slice(0, 120)}` };
  const actions = Array.isArray(res.json?.actions) ? res.json.actions : [];
  const labels = actions.map((a) => String(a.label || a.type || ""));
  const hasOpen = actions.some((a) => /open in yaver/i.test(a.label || "") || a.type === "open-native");
  const nativeFamily = frameworkMatches(project, ["expo", "react-native", "flutter", "swift", "ios", "kotlin", "android"]);
  return {
    ok: !nativeFamily || hasOpen || actions.length > 0,
    detail: labels.slice(0, 5).join(", ") || "no actions",
  };
}

async function stopServing() {
  await agent("/dev/stop", { method: "POST", body: "{}" }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
}

async function startPreview(project, target) {
  if (!START_PREVIEW) return { skipped: true };
  if (!project?.path) return { ok: false, detail: "no project path" };
  await stopServing();
  const framework = (target.frameworks || [project.framework || ""])[0];
  const start = await agent("/dev/start", {
    method: "POST",
    body: JSON.stringify({
      framework,
      workDir: project.path,
      platform: "web",
      caller: "ios-sim-closed-loop",
    }),
  });
  if (!start.ok) return { ok: false, detail: `HTTP ${start.status}: ${(start.json?.error || start.text).slice(0, 180)}` };
  const deadline = Date.now() + BOOT_BUDGET_MS;
  let last = "";
  while (Date.now() < deadline) {
    const status = await agent("/dev/status");
    const body = status.json || {};
    if (body.error) last = String(body.error);
    if (body.running && (body.webPort > 0 || body.port > 0)) {
      const actualWorkDir = String(body.workDir || "");
      const actualFramework = String(body.framework || "");
      const wrongDir = actualWorkDir && actualWorkDir !== project.path;
      const wrongFramework = actualFramework && !frameworkMatches({ framework: actualFramework }, [framework]);
      if (wrongDir || wrongFramework) {
        return {
          ok: false,
          detail: `wrong dev server started: framework=${actualFramework || "unknown"} workDir=${actualWorkDir || "unknown"}`,
        };
      }
      return { ok: true, detail: `running ${actualFramework || framework} workDir=${actualWorkDir || project.path}` };
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  return { ok: false, detail: last || "dev server did not become ready" };
}

async function remoteMatrixLoop() {
  const inventory = await getAllProjectRows();
  const projects = inventory.merged;
  const rows = [];
  for (const target of MATRIX.projects) {
    const project = pickProject(projects, target);
    if (!project) {
      rows.push({ target, verdict: target.required ? "FAIL" : "SKIP", detail: "not found in /projects/mobile or /projects" });
      continue;
    }
    const fwOK = !target.frameworks?.length || frameworkMatches(project, target.frameworks);
    const actions = await checkActions(project);
    const preview = await startPreview(project, target);
    const ok = fwOK && actions.ok && (preview.skipped || preview.ok);
    const detail = [
      `${project.name} :: ${project.path}`,
      `framework=${project.framework || Array.from(frameworkSet(project)).join("/") || "unknown"}${fwOK ? "" : ` expected ${target.frameworks.join("/")}`}`,
      `actions=${actions.detail}`,
      preview.skipped ? "preview=skipped" : `preview=${preview.ok ? "ready" : preview.detail}`,
    ].join(" | ");
    rows.push({ target, verdict: ok ? "PASS" : "FAIL", detail });
  }
  return { inventory, rows };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  let simLog = null;
  let simResult = null;
  try {
    simResult = await simulatorLoop();
    if (simResult?.udid) simLog = startSimulatorLog(simResult.udid);
    const remote = await remoteMatrixLoop();
    const afterShot = simResult?.udid ? await screenshot(simResult.udid, "ios-after-remote-matrix").catch(() => "") : "";
    const logPath = simLog?.stop?.() || "";

    console.log("\n===== iOS SIMULATOR =====");
    if (simResult?.skipped) console.log("SKIP simulator launch");
    else console.log(`PASS ${simResult.name} launched ${BUNDLE_ID}\n  app: ${simResult.appPath}\n  screenshot: ${simResult.screenshot}${afterShot ? `\n  after: ${afterShot}` : ""}${logPath ? `\n  log: ${logPath}` : ""}`);

    console.log("\n===== MAC MINI PROJECT MATRIX =====");
    for (const row of remote.rows) {
      console.log(`${row.verdict.padEnd(4)} ${row.target.id.padEnd(18)} ${row.detail}`);
    }
    const failures = remote.rows.filter((r) => r.verdict === "FAIL");
    const summary = {
      at: new Date().toISOString(),
      agentUrl: AGENT_URL,
      simulator: simResult,
      matrixFile: MATRIX_FILE,
      inventory: {
        mobileCount: remote.inventory.mobile.projects?.length || 0,
        generalCount: remote.inventory.general.projects?.length || 0,
        scanning: !!remote.inventory.mobile.scanning,
        scanError: remote.inventory.mobile.scanError || "",
      },
      results: remote.rows.map((r) => ({ id: r.target.id, verdict: r.verdict, detail: r.detail })),
      screenshots: [simResult?.screenshot, afterShot].filter(Boolean),
      simulatorLog: logPath,
    };
    const report = join(OUT_DIR, "report.json");
    writeFileSync(report, JSON.stringify(summary, null, 2));
    console.log(`\nreport: ${report}`);
    process.exit(failures.length ? 1 : 0);
  } catch (err) {
    const logPath = simLog?.stop?.() || "";
    if (logPath) console.error(`simulator log: ${logPath}`);
    console.error(`FAIL ${err?.message || err}`);
    process.exit(1);
  }
}

main();
