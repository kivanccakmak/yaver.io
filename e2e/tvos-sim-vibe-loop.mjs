#!/usr/bin/env node
/**
 * tvos-sim-vibe-loop.mjs — the REAL tvOS app, in the simulator, showing a
 * preview streamed from ubuntu-4gb, vibed black → RED → black.
 *
 *   YAVER_TEST_TOKEN=… npx tsx e2e/tvos-sim-vibe-loop.mjs
 *
 * ── What makes this different from every earlier "tvOS loop" ───────────────
 *
 * `native-headless-vibe.mjs tv` samples a frame the BOX captured at TV
 * geometry. It proves the server half and says so on every run. It never runs
 * the TV app, so it cannot see anything the app gets wrong — and the app got
 * two things wrong that this arc found in its first hour:
 *
 *   • AgentClient.previewFrame omitted ?project=, so the endpoint returned a
 *     JSON error instead of PNG bytes and WebPreviewStreamView could never have
 *     rendered a frame in production.
 *   • Info.plist had only NSAllowsLocalNetworking, so ATS refused every request
 *     to a 100.64/10 box before a packet left the device — and the TV reported
 *     it as "Box asleep, start it from your computer", about a machine that was
 *     answering GET /info with 200 throughout.
 *
 * Here the client is the app itself, in the simulator, and the verdict comes
 * from the simulator's own screen.
 *
 * ── Division of labour ─────────────────────────────────────────────────────
 *
 * The XCUITest (tvos/YaverTVUITests) drives the UI and writes screenshots. This
 * file prepares the box, triggers the vibe, and decides the colour — with the
 * SHARED classifier from web/lib/vibeVerdict.ts. The verdict is never
 * reimplemented in Swift: it has been wrong twice in ways that made a working
 * product look broken, and a second copy would drift.
 *
 * ── A SKIP IS NOT A PASS ───────────────────────────────────────────────────
 *
 * xcodebuild exits 0 for "1 test skipped, 0 failures". Measured on this arc's
 * first run, when the token never reached the test process (xcodebuild forwards
 * only TEST_RUNNER_-prefixed variables). An orchestrator trusting the exit code
 * would have called that green. This one reads the log.
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { classifyVibeColor, looksRendered, modalColor, samplePoints, verdictFor } from "../web/lib/vibeVerdict.ts";
import { profileFor } from "../web/lib/surfaceViewports.ts";
import { decodePng, samplePixels } from "./_framePixels.mjs";
import * as oracle from "./_visionOracle.mjs";

const configPath = join(os.homedir(), ".yaver", "config.json");
const localConfig = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
const TOKEN = process.env.YAVER_TEST_TOKEN || localConfig.auth_token || "";

// The box address has NO DEFAULT, deliberately.
//
// It used to fall back to one machine's tailnet IP. That is the single-user bug
// CLAUDE.md forbids wearing a test's clothes: every arc silently targeted one
// person's box, so anyone else's run measured a machine they do not own, and a
// real overlay address sat in a PUBLIC repo. Unset is unset — say so and skip.
let BOX = process.env.VIBE_BOX_HOST || "";
const DEVICE = process.env.VIBE_BOX || "ubuntu-4gb-hel1-1";
let resolvedDeviceID = "";
const PROJECT = process.env.VIBE_PROJECT_NAME || "mobile";
const SOURCE_WORKDIR = process.env.VIBE_PROJECT_PATH || "/root/Workspace/yaver.io/mobile";
let WORKDIR = SOURCE_WORKDIR;
const PRESERVE_SOURCE = process.env.VIBE_PRESERVE_SOURCE !== "0";
const SIM = process.env.TV_SIM_NAME || "YaverTV-AppStore-1080p";
const CAPTURE_SEC = Number(process.env.TV_CAPTURE_SECONDS || 420);
const RUN_ID = process.env.LOOP_RUN_ID || new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = new URL(`./test-results/loops/${RUN_ID}/tvos-sim/`, import.meta.url).pathname;
const REPO = new URL("..", import.meta.url).pathname;
const PROFILE = profileFor("tv");

/// How much of the TV screen must be red for the PREVIEW to count as red.
///
/// The preview is a sub-region, not the whole screen — see the sampling block
/// below for the measurement (0.0% at launch, 22.3% with a red preview).
const RED_PANEL_FRACTION = Number(process.env.TV_RED_FRACTION || 0.08);

const log = (m) => console.log(`[tvos-sim] ${m}`);
const h = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

// A remote owned box may deliberately expose no direct HTTP address. Native
// clients still need to be tested against that real box, and a Chromium relay
// result is not a substitute. When no direct URL is supplied, bind a loopback
// adapter for the simulator and forward each request through Yaver's existing
// authenticated relay with the same bearer boundary plus the owner's relay
// credential. This changes no production CORS/auth rule and writes no secret
// into launch arguments beyond the bearer token the test already required.
async function startLoopbackRelayAdapter() {
  const relayPassword = String(localConfig.cached_relay_password || localConfig.relay_password || "").trim();
  if (!TOKEN || !relayPassword) return null;
  const convex = String(
    process.env.YAVER_CONVEX_SITE || localConfig.convex_site_url ||
      "https://perceptive-minnow-557.eu-west-1.convex.site",
  ).replace(/\/$/, "");
  const relay = String(process.env.YAVER_RELAY_HTTP || "https://public.yaver.io").replace(/\/$/, "");
  const listed = await fetch(`${convex}/devices/list`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!listed.ok) throw new Error(`device resolution returned HTTP ${listed.status}`);
  const body = await listed.json();
  const rows = Array.isArray(body) ? body : body?.devices || body?.data || [];
  const needle = DEVICE.toLowerCase();
  const matches = rows.filter((row) =>
    String(row.name || row.hostname || "").toLowerCase().includes(needle));
  if (matches.length !== 1) throw new Error(`${JSON.stringify(DEVICE)} matched ${matches.length} owned devices`);
  const deviceID = String(matches[0].deviceId || matches[0].id || matches[0]._id || "");
  if (!deviceID) throw new Error("resolved device has no id");
  resolvedDeviceID = deviceID;

  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = chunks.length ? Buffer.concat(chunks) : undefined;
      const upstream = await fetch(`${relay}/d/${encodeURIComponent(deviceID)}${req.url || "/"}`, {
        method: req.method,
        headers: {
          Authorization: req.headers.authorization || `Bearer ${TOKEN}`,
          "X-Relay-Password": relayPassword,
          ...(req.headers["content-type"] ? { "Content-Type": req.headers["content-type"] } : {}),
          ...(req.headers.accept ? { Accept: req.headers.accept } : {}),
        },
        body: /^(GET|HEAD)$/i.test(req.method || "GET") ? undefined : payload,
      });
      res.statusCode = upstream.status;
      const contentType = upstream.headers.get("content-type");
      if (contentType) res.setHeader("Content-Type", contentType);
      const cacheControl = upstream.headers.get("cache-control");
      if (cacheControl) res.setHeader("Cache-Control", cacheControl);
      if (upstream.body) {
        // Preserve SSE and frame streaming. Buffering the whole response made
        // the TV report five stream timeouts while the task itself completed
        // in 42 seconds — a relay adapter that turns a stream into a response
        // blob is not a faithful native transport test.
        Readable.fromWeb(upstream.body).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: `relay adapter failed: ${err.message}` }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  BOX = `http://127.0.0.1:${address.port}`;
  log(`using a loopback adapter to the owned device ${DEVICE}`);
  return server;
}

function skip(reason, remedy) {
  console.log(`\n[tvos-sim] SKIP — ${reason}`);
  if (remedy) console.log(`[tvos-sim] fix: ${remedy}`);
  console.log("\ntvos-sim: SKIPPED (NAMED)");
  process.exit(0);
}

async function api(path, init = {}) {
  const res = await fetch(`${BOX}${path}`, { ...init, headers: { ...h, ...(init.headers || {}) } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${init.method || "GET"} ${path} → HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
  }
  return res.headers.get("content-type")?.includes("json") ? res.json() : res.arrayBuffer();
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function remoteExec(command, timeoutSec = 120) {
  const started = await api("/exec", {
    method: "POST",
    body: JSON.stringify({ command, timeoutSec }),
  });
  const execID = started?.execId;
  if (!execID) throw new Error("remote exec returned no id");
  const deadline = Date.now() + (timeoutSec + 15) * 1_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const polled = await api(`/exec/${execID}`);
    const row = polled?.exec || polled || {};
    if (["completed", "failed", "cancelled"].includes(row.status)) {
      if (row.status !== "completed" || Number(row.exitCode) !== 0) {
        throw new Error(`remote command ${row.status} (exit ${row.exitCode})`);
      }
      return String(row.stdout || "");
    }
  }
  throw new Error(`remote command exceeded ${timeoutSec + 15}s`);
}

let disposable = null;
async function createDisposableWorktree() {
  const safeProject = PROJECT.replace(/[^A-Za-z0-9._-]/g, "-") || "project";
  const command =
    `parent=$(mktemp -d /tmp/yaver-native-tvos-XXXXXX) && ` +
    `worktree="$parent/${safeProject}" && ` +
    `git -C ${shellQuote(SOURCE_WORKDIR)} worktree add --detach "$worktree" HEAD >/dev/null && ` +
    `rsync -a --exclude=.git --exclude=node_modules --exclude=keys --exclude=.expo ` +
    `${shellQuote(SOURCE_WORKDIR + "/")} "$worktree/" && ` +
    `if [ -d ${shellQuote(SOURCE_WORKDIR + "/node_modules")} ]; then ` +
    `cp -al ${shellQuote(SOURCE_WORKDIR + "/node_modules")} "$worktree/node_modules"; fi && ` +
    `printf '%s\\n%s\\n' "$parent" "$worktree"`;
  const lines = (await remoteExec(command, 120)).trim().split("\n");
  const parent = lines.at(-2) || "";
  const worktree = lines.at(-1) || "";
  if (!/^\/tmp\/yaver-native-tvos-[A-Za-z0-9]+$/.test(parent) || worktree !== `${parent}/${safeProject}`) {
    throw new Error("remote worktree returned an unsafe path");
  }
  disposable = { parent, worktree };
  WORKDIR = worktree;
  log(`using a disposable ${PROJECT} worktree on ${DEVICE}`);
}

async function cleanupDisposableWorktree() {
  if (!disposable) return;
  const { parent, worktree } = disposable;
  if (!/^\/tmp\/yaver-native-tvos-[A-Za-z0-9]+$/.test(parent) || !worktree.startsWith(`${parent}/`)) {
    throw new Error("refusing unsafe remote cleanup paths");
  }
  await remoteExec(
    `ls -la ${shellQuote(parent)} ${shellQuote(worktree)} >/dev/null && ` +
    `git -C ${shellQuote(SOURCE_WORKDIR)} worktree remove --force ${shellQuote(worktree)} && ` +
    `rmdir ${shellQuote(parent)}`,
    60,
  );
  disposable = null;
  log("removed the inspected disposable remote worktree");
}

if (!TOKEN) skip("set YAVER_TEST_TOKEN (a session token for the box's owner)");
if (process.platform !== "darwin") skip("tvOS simulators are macOS-only");
let relayAdapter = null;
if (!BOX) {
  relayAdapter = await startLoopbackRelayAdapter().catch((err) =>
    skip(`could not establish the native relay lane: ${err.message}`,
      "sign in with yaver and ensure the owned device is relay-connected"));
}
if (!BOX) skip("set VIBE_BOX_HOST or sign in so the loopback relay lane can resolve an owned device");

// ── 0. Box preflight ────────────────────────────────────────────────────────
const info = await api("/info").catch((e) => skip(`the box did not answer: ${e.message}`,
  "check the box is up and .env.test's token is current"));
log(`box ${info.hostname} · agent ${info.version}`);
if (PRESERVE_SOURCE) {
  await createDisposableWorktree().catch((e) =>
    skip(`could not create a preservation-safe remote worktree: ${e.message}`,
      "verify the selected project is a Git worktree with rsync installed"));
}

// The TV renders what the BOX captures, so the browser lane has to be up before
// the app can show anything. Starting it here rather than inside the XCUITest
// keeps the Swift side to UI driving only.
const ds = info.devServer || {};
if (!ds.running || PRESERVE_SOURCE) {
  log("starting the dev server on the box…");
  await api("/dev/start", {
    method: "POST",
    body: JSON.stringify({ framework: "expo", workDir: WORKDIR, devMode: "web" }),
  }).catch((e) => skip(`could not start the dev server: ${e.message}`));
}

// ── 1. Build for testing ────────────────────────────────────────────────────
mkdirSync(RUN_DIR, { recursive: true });
const derived = join(RUN_DIR, "..", "DerivedData-tvos");
try {
  execFileSync("xcodegen", ["generate"], { cwd: join(REPO, "tvos"), stdio: "pipe" });
} catch (err) {
  skip(`xcodegen could not generate the tvOS project: ${String(err.stderr || err).slice(0, 160)}`, "brew install xcodegen");
}
log("building the app + UI test bundle for the tvOS Simulator…");
try {
  execFileSync("xcodebuild", [
    "-project", join(REPO, "tvos", "YaverTV.xcodeproj"),
    "-scheme", "YaverTV",
    "-destination", `platform=tvOS Simulator,name=${SIM}`,
    "-derivedDataPath", derived,
    "CODE_SIGNING_ALLOWED=NO",
    "build-for-testing",
  ], { stdio: "pipe", timeout: 20 * 60_000 });
} catch (err) {
  const out = String(err.stdout || "") + String(err.stderr || "");
  const errors = out.split("\n").filter((l) => / error: /.test(l)).slice(0, 6);
  console.error(`[tvos-sim] BUILD FAILED\n${errors.join("\n") || out.slice(-1200)}`);
  console.log("\ntvos-sim: NAMED — the tvOS app does not build for its own simulator");
  process.exit(1);
}

// ── 2. Run the UI test, and vibe while it watches ───────────────────────────
const logPath = join(RUN_DIR, "xcodebuild-test.log");
const child = spawn("xcodebuild", [
  "test-without-building",
  "-project", join(REPO, "tvos", "YaverTV.xcodeproj"),
  "-scheme", "YaverTV",
  "-destination", `platform=tvOS Simulator,name=${SIM}`,
  "-derivedDataPath", derived,
  "-only-testing:YaverTVUITests",
], {
  env: {
    ...process.env,
    // TEST_RUNNER_ prefix or it never reaches the test process.
    TEST_RUNNER_YAVER_SHOT_DIR: RUN_DIR,
    TEST_RUNNER_YAVER_BOX_TOKEN: TOKEN,
    TEST_RUNNER_YAVER_BOX_HOST: new URL(BOX).hostname,
    TEST_RUNNER_YAVER_BOX_PORT: String(new URL(BOX).port || 18080),
    TEST_RUNNER_YAVER_BOX_ID: resolvedDeviceID || "closed-loop-box",
    TEST_RUNNER_YAVER_PROJECT: PROJECT,
    TEST_RUNNER_YAVER_CAPTURE_SECONDS: String(CAPTURE_SEC),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let testLog = "";
child.stdout.on("data", (d) => { testLog += d; });
child.stderr.on("data", (d) => { testLog += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Same body AgentClient.createTask sends — runner/model omitted so the box
 *  applies its own primary and this can never drift onto a dead model. */
async function vibe(description) {
  return api("/tasks", {
    method: "POST",
    body: JSON.stringify({ title: description.slice(0, 60), description, workDir: WORKDIR }),
  });
}

async function waitForTaskTerminal(taskID, timeoutMs = 8 * 60_000) {
  const terminal = new Set(["completed", "review", "failed", "stopped", "cancelled"]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await api(`/tasks/${encodeURIComponent(taskID)}`);
    const task = row?.task || row;
    if (terminal.has(task?.status)) return task;
    await sleep(2_000);
  }
  throw new Error(`task ${taskID.slice(0, 8)} did not reach a terminal state`);
}

// Let the app launch and reach the preview before changing anything under it.
await sleep(60_000);
log("sending the colour turn…");
const createdTask = await vibe(
  `In the SFMG repo at ${WORKDIR}, change the CURRENTLY VISIBLE "Choose Your Language" / ` +
  `"Dil Seçimi" screen so its entire visible full-screen background is EXACTLY #D32F2F. ` +
  `Every full-screen container that paints over it must use #D32F2F. Change only what is ` +
  `needed for that visible background. Do not commit, push, install dependencies, start a ` +
  `dev server, or edit outside ${WORKDIR}.`,
).catch((e) => {
  console.error(`[tvos-sim] could not create the task: ${e.message}`);
  return null;
});
const createdTaskID = String(createdTask?.id || createdTask?.task?.id || createdTask?.taskId || "");

const testExitCode = await new Promise((resolve) => child.on("close", resolve));
writeFileSync(logPath, testLog);
let terminalTask = null;
if (createdTaskID) {
  terminalTask = await waitForTaskTerminal(createdTaskID).catch((e) => {
    console.error(`[tvos-sim] ${e.message}`);
    return null;
  });
}
await cleanupDisposableWorktree().catch((e) => {
  console.error(`[tvos-sim] cleanup failed: ${e.message}`);
  console.log("\ntvos-sim: NAMED — disposable remote worktree cleanup did not complete");
  process.exit(1);
});

if (testExitCode !== 0) {
  const failed = (testLog.match(/Test Case .* failed[^\n]*/g) || []).slice(-4);
  console.log(`\ntvos-sim: NAMED — native XCUITests failed (exit ${testExitCode})${failed.length ? `: ${failed.join("; ")}` : ""}`);
  process.exit(1);
}
if (!createdTaskID || !terminalTask) {
  console.log("\ntvos-sim: NAMED — the native capture had no completed remote task to judge");
  process.exit(1);
}
if (["failed", "stopped", "cancelled"].includes(terminalTask.status)) {
  console.log(`\ntvos-sim: NAMED — remote task ended ${terminalTask.status}`);
  process.exit(1);
}

// A SKIP IS NOT A PASS. xcodebuild exits 0 for "1 test skipped, 0 failures".
if (/with \d+ test[s]? skipped/.test(testLog)) {
  const why = (testLog.match(/Test skipped[^\n]*/) || ["(no reason given)"])[0];
  skip(`the UI test SKIPPED, so nothing was driven: ${why.slice(0, 200)}`,
    "check TEST_RUNNER_YAVER_BOX_TOKEN reaches the test process");
}
if (/Executed 0 tests/.test(testLog)) {
  console.log("\ntvos-sim: NAMED — the runner executed 0 tests (crash or timeout); see " + logPath);
  process.exit(1);
}

// ── 3. The verdict, from the SIMULATOR's own pixels ─────────────────────────
const frames = readdirSync(RUN_DIR).filter((f) => f.endsWith(".png")).sort();
if (!frames.length) {
  console.log("\ntvos-sim: SILENT — the UI test wrote no frames at all");
  process.exit(1);
}

const timeline = [];
let sawRed = false;
let lastRendered = null;
for (const f of frames) {
  const path = join(RUN_DIR, f);
  let entry = { file: f };
  try {
    const img = decodePng(readFileSync(path));
    const samples = samplePixels(img, samplePoints, 6);

    // FRACTION, NOT MODAL COLOUR — and this is not a tuning choice.
    //
    // The preview is a PHONE-shaped panel inside a 1920x1080 TV screen. The
    // modal colour of the whole screen is therefore the TV's own black chrome,
    // so a preview that is ENTIRELY RED still classifies as "black". The first
    // full run reported exactly that: thirty frames, "colours: black", while
    // the box's login.tsx carried three red containers and the task sat in
    // `review`. The product had done the work; the verdict function was
    // measuring the wrong thing.
    //
    // That is the failure mode vibeVerdict.ts's own header names — a test wrong
    // in the DIRECTION OF FAILURE sends real investigations after systems that
    // work — reproduced by using its modal-colour helper on a surface it was
    // not written for. The helper is right for a browser arc, where the preview
    // fills the viewport. It is wrong here.
    //
    // Measured on those same frames: launch screen 0.0% red, preview-showing-red
    // 22.3%. The threshold sits well clear of both, so it cannot be tripped by
    // Yaver's own red error chrome (a banner is a rounding error at this scale)
    // and cannot miss a preview that genuinely turned.
    let redCount = 0;
    for (const px of samples) if (classifyVibeColor(px) === "red") redCount++;
    const redFraction = samples.length ? redCount / samples.length : 0;

    entry = {
      ...entry,
      size: `${img.width}x${img.height}`,
      color: classifyVibeColor(modalColor(samples)),
      redFraction: Number((redFraction * 100).toFixed(1)),
      rendered: looksRendered(samples),
    };
    if (redFraction >= RED_PANEL_FRACTION && entry.rendered) sawRed = true;
    if (entry.rendered) lastRendered = entry;
  } catch (err) {
    entry.decodeError = err.message;
  }
  timeline.push(entry);
}

log(`${frames.length} frames · peak red ${Math.max(0, ...timeline.map((t) => t.redFraction || 0)).toFixed(1)}% · colours: ${[...new Set(timeline.map((t) => t.color))].join(", ")}`);

let reason = "";
if (!sawRed) {
  // The oracle reads the LAST frame: on this surface a failure is usually the
  // app saying something (a notice, a sign-in wall, "Box asleep") rather than a
  // wrong colour, and that sentence is the actual finding.
  const last = join(RUN_DIR, frames[frames.length - 1]);
  const seen = oracle.explainFrame(last, { expected: ["signed-out"] });
  reason = `the TV never rendered a red preview (peak red ${Math.max(0, ...timeline.map((t) => t.redFraction || 0)).toFixed(1)}%, need ${(RED_PANEL_FRACTION * 100).toFixed(0)}%). `
    + (seen ? seen.reason : "the oracle read no text off the final frame");
}

writeFileSync(join(RUN_DIR, "manifest.json"), JSON.stringify({
  surface: "tvos-sim", runId: RUN_ID,
  transport: relayAdapter ? "loopback-authenticated-relay" : "explicit-direct",
  project: PROJECT,
  simulator: SIM, profile: { width: PROFILE.width, height: PROFILE.height },
  verdict: sawRed ? "PIXELS" : "NAMED", reason, frames: timeline,
}, null, 2));

const { verdict, reason: verdictReason } = verdictFor({
  reachedTarget: sawRed, reverted: sawRed, reason,
});
log(`artifacts: ${RUN_DIR}`);
console.log(`\ntvos-sim: ${verdict} — ${verdictReason}`);
process.exit(verdict === "PIXELS" ? 0 : 1);
