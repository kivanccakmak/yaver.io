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
import { join } from "node:path";
import { classifyVibeColor, looksRendered, modalColor, samplePoints, verdictFor } from "../web/lib/vibeVerdict.ts";
import { profileFor } from "../web/lib/surfaceViewports.ts";
import { decodePng, samplePixels } from "./_framePixels.mjs";
import * as oracle from "./_visionOracle.mjs";

const TOKEN = process.env.YAVER_TEST_TOKEN || "";
const BOX = process.env.VIBE_BOX_HOST || "http://100.75.123.78:18080";
const PROJECT = process.env.VIBE_PROJECT_NAME || "mobile";
const WORKDIR = process.env.VIBE_PROJECT_PATH || "/root/Workspace/yaver.io/mobile";
const SIM = process.env.TV_SIM_NAME || "YaverTV-AppStore-1080p";
const CAPTURE_SEC = Number(process.env.TV_CAPTURE_SECONDS || 420);
const RUN_ID = process.env.LOOP_RUN_ID || new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = new URL(`./test-results/loops/${RUN_ID}/tvos-sim/`, import.meta.url).pathname;
const REPO = new URL("..", import.meta.url).pathname;
const PROFILE = profileFor("tv");

const log = (m) => console.log(`[tvos-sim] ${m}`);
const h = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

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

if (!TOKEN) skip("set YAVER_TEST_TOKEN (a session token for the box's owner)");
if (process.platform !== "darwin") skip("tvOS simulators are macOS-only");

// ── 0. Box preflight ────────────────────────────────────────────────────────
const info = await api("/info").catch((e) => skip(`the box did not answer: ${e.message}`,
  "check the box is up and .env.test's token is current"));
log(`box ${info.hostname} · agent ${info.version}`);

// The TV renders what the BOX captures, so the browser lane has to be up before
// the app can show anything. Starting it here rather than inside the XCUITest
// keeps the Swift side to UI driving only.
const ds = info.devServer || {};
if (!ds.running) {
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

// Let the app launch and reach the preview before changing anything under it.
await sleep(60_000);
log("sending the colour turn…");
await vibe(
  "Change the login screen so its VISIBLE background is red. Every container that paints " +
  "the full-screen background must be red, so the whole screen reads red. Only the login screen.",
).catch((e) => log(`(could not create the task: ${e.message})`));

await new Promise((resolve) => child.on("close", resolve));
writeFileSync(logPath, testLog);

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
    const samples = samplePixels(img, samplePoints, 8);
    entry = {
      ...entry,
      size: `${img.width}x${img.height}`,
      color: classifyVibeColor(modalColor(samples)),
      rendered: looksRendered(samples),
    };
    if (entry.color === "red" && entry.rendered) sawRed = true;
    if (entry.rendered) lastRendered = entry;
  } catch (err) {
    entry.decodeError = err.message;
  }
  timeline.push(entry);
}

log(`${frames.length} frames · colours: ${[...new Set(timeline.map((t) => t.color))].join(", ")}`);

let reason = "";
if (!sawRed) {
  // The oracle reads the LAST frame: on this surface a failure is usually the
  // app saying something (a notice, a sign-in wall, "Box asleep") rather than a
  // wrong colour, and that sentence is the actual finding.
  const last = join(RUN_DIR, frames[frames.length - 1]);
  const seen = oracle.explainFrame(last, { expected: ["signed-out"] });
  reason = `the TV never rendered a red preview (last ${lastRendered?.color ?? "nothing rendered"}). `
    + (seen ? seen.reason : "the oracle read no text off the final frame");
}

writeFileSync(join(RUN_DIR, "manifest.json"), JSON.stringify({
  surface: "tvos-sim", runId: RUN_ID, box: BOX, project: PROJECT,
  simulator: SIM, profile: { width: PROFILE.width, height: PROFILE.height },
  verdict: sawRed ? "PIXELS" : "NAMED", reason, frames: timeline,
}, null, 2));

const { verdict, reason: verdictReason } = verdictFor({
  reachedTarget: sawRed, reverted: sawRed, reason,
});
log(`artifacts: ${RUN_DIR}`);
console.log(`\ntvos-sim: ${verdict} — ${verdictReason}`);
process.exit(verdict === "PIXELS" ? 0 : 1);
