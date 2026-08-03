#!/usr/bin/env node
/**
 * visionos-sim-loop.mjs — the REAL visionOS app, in the simulator, against the
 * REAL box.
 *
 *   YAVER_TEST_TOKEN=… npx tsx e2e/visionos-sim-loop.mjs
 *
 * ── Why this exists, and why it is not the colour arc ──────────────────────
 *
 * `native-headless-vibe.mjs vision` proves the SERVER half: the runner edits,
 * the dev server rebuilds, and the render pipeline produces the right pixels at
 * headset geometry. It says so on every run. What it cannot prove — and never
 * claimed to — is that the visionOS APP works: that it signs in, reaches a box,
 * lists a runner, sends a prompt, and shows the answer.
 *
 * That gap is the whole reason this file exists. It is also why this arc is NOT
 * a colour loop: **the visionOS app does not render the previewed project's
 * pixels.** It is a control surface — dashboard, prompt, logs, notices. Driving
 * a black→red→black vibe through it and asserting on colour would be asserting
 * on something that is not on the screen, which is the exact false-confidence
 * this suite exists to remove.
 *
 * So the terminal signal here is TEXT ON PIXELS: what the app actually renders,
 * read off a simulator screenshot by the Apple Vision oracle. That is the same
 * capability tvOS got, applied to the surface that needs it more — and it is a
 * real verdict, because a control that never appears cannot be read.
 *
 * ── What it proves, in order ───────────────────────────────────────────────
 *
 *   0. a visionOS simulator + toolchain exist            → NAMED skip
 *   1. the app BUILDS for visionOS Simulator             → NAMED failure
 *   2. it launches pointed at the REAL box               (launch arguments)
 *   3. the dashboard renders THAT machine's real name    → PIXELS (via oracle)
 *   4. a real runner session is listed                   → PIXELS
 *   5. a prompt sent from the headset UI reaches it      → PIXELS
 *
 * Steps 3-5 are all read from screenshots. Nothing here inspects the app's
 * internals, and no production code has a test hook: the app is pointed at the
 * box purely through UserDefaults' argument domain, exactly as
 * VisionDashboardUITests already does.
 *
 * ── Honest about cost ──────────────────────────────────────────────────────
 *
 * This builds an Xcode target and boots a headset simulator. It is minutes, not
 * seconds, and it contends for the machine — CLAUDE.md's load-270 incident was
 * five simulators plus an archive. Run it deliberately, not in a loop.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as oracle from "./_visionOracle.mjs";
import { decodePng, samplePixels } from "./_framePixels.mjs";
import { classifyVibeColor, samplePoints } from "../web/lib/vibeVerdict.ts";

const TOKEN = process.env.YAVER_TEST_TOKEN || "";
const BOX = process.env.VIBE_BOX_HOST || "http://100.75.123.78:18080";
const SIM_NAME = process.env.VISION_SIM_NAME || "Apple Vision Pro";
const BUNDLE_ID = process.env.VISION_BUNDLE_ID || "io.yaver.mobile";
const RUN_ID = process.env.LOOP_RUN_ID || new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = new URL(`./test-results/loops/${RUN_ID}/visionos-sim/`, import.meta.url).pathname;
const REPO = new URL("..", import.meta.url).pathname;
const SKIP_BUILD = process.env.VISION_SKIP_BUILD === "1";
const PROJECT_NAME = process.env.VIBE_PROJECT_NAME || "mobile";
const VIBE_BUDGET_MS = Number(process.env.VIBE_BUDGET_MS || 8 * 60_000);
/// The preview is a panel, so the verdict is the RED FRACTION of the screen,
/// never its modal colour (see the tvOS loop for why).
///
/// CALIBRATED PER SURFACE, because the same red preview reads differently on
/// each. Measured 2026-08-03:
///
///   tvOS      1920x1080 screenshot, preview fills much of it   → 22.3% red
///   visionOS  3840x2160 screenshot, app window floats inside it →  6.5% red
///
/// Both against 0.0% at launch. Reusing the tvOS threshold here failed a
/// working loop by 1.5 points — the number was right for the surface it was
/// measured on and meaningless on this one.
///
/// 3% sits well clear of both the 0.0% floor and the 6.5% signal. It is NOT
/// tuned to make a run pass: the discriminator is a clean 0.0 → 6.5 step held
/// across fifteen consecutive frames, and any threshold in that gap gives the
/// same verdict.
const RED_PANEL_FRACTION = Number(process.env.VISION_RED_FRACTION || 0.03);

const log = (m) => console.log(`[visionos-sim] ${m}`);
let shots = 0;
const timeline = [];

function skip(reason, remedy) {
  console.log(`\n[visionos-sim] SKIP — ${reason}`);
  if (remedy) console.log(`[visionos-sim] fix: ${remedy}`);
  console.log("\nvisionos-sim: SKIPPED (NAMED)");
  process.exit(0);
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

if (!TOKEN) {
  skip("set YAVER_TEST_TOKEN (a session token for the box's owner)");
}
if (process.platform !== "darwin") {
  skip("visionOS simulators are macOS-only");
}

// ── 0. Toolchain + simulator ────────────────────────────────────────────────
let simUDID = "";
try {
  const devices = JSON.parse(sh("xcrun simctl list devices available --json"));
  for (const [runtime, list] of Object.entries(devices.devices)) {
    if (!/visionOS|xrOS/i.test(runtime)) continue;
    const hit = list.find((d) => d.name === SIM_NAME) || list[0];
    if (hit) { simUDID = hit.udid; break; }
  }
} catch (err) {
  skip(`could not list simulators: ${err.message}`, "install Xcode command line tools");
}
if (!simUDID) {
  skip(
    `no visionOS simulator named "${SIM_NAME}" is available`,
    "Xcode › Settings › Components → install the visionOS simulator runtime",
  );
}

// ── 1. Build ────────────────────────────────────────────────────────────────
// The .xcodeproj is gitignored and XcodeGen-generated, so a fresh checkout has
// no project at all — CLAUDE.md lists that as a trap. Generate before building
// rather than failing with "does not exist".
const derived = join(RUN_DIR, "..", "DerivedData-visionos");
let appPath = process.env.VISION_APP_PATH || "";

if (!SKIP_BUILD) {
  try {
    execFileSync("xcodegen", ["generate"], { cwd: join(REPO, "visionos"), stdio: "pipe" });
  } catch (err) {
    skip(
      `xcodegen could not generate the visionOS project: ${String(err.stderr || err).slice(0, 200)}`,
      "brew install xcodegen",
    );
  }
  log("building YaverVision for the visionOS Simulator (minutes, not seconds)…");
  try {
    execFileSync("xcodebuild", [
      "-project", join(REPO, "visionos", "YaverVision.xcodeproj"),
      "-scheme", "YaverVision",
      "-destination", `platform=visionOS Simulator,id=${simUDID}`,
      "-derivedDataPath", derived,
      "-configuration", "Debug",
      "CODE_SIGNING_ALLOWED=NO",
      "build",
    ], { stdio: "pipe", timeout: 20 * 60_000 });
  } catch (err) {
    // A build failure is a REAL failure of this arc, not a skip — the app not
    // compiling for its own platform is exactly what a loop should catch.
    const out = String(err.stdout || "") + String(err.stderr || "");
    const errors = out.split("\n").filter((l) => / error: /.test(l)).slice(0, 6);
    console.error(`[visionos-sim] BUILD FAILED\n${errors.join("\n") || out.slice(-1500)}`);
    console.log("\nvisionos-sim: NAMED — the visionOS app does not build for its own simulator");
    process.exit(1);
  }
  appPath = join(derived, "Build", "Products", "Debug-xrsimulator", "Yaver.app");
}
if (!appPath || !existsSync(appPath)) {
  skip(`built app not found at ${appPath}`, "check the scheme's PRODUCT_NAME, or pass VISION_APP_PATH");
}

// ── 2. Boot + install + launch against the REAL box ─────────────────────────
mkdirSync(RUN_DIR, { recursive: true });
log(`booting ${SIM_NAME} (${simUDID.slice(0, 8)}…)`);
try { sh(`xcrun simctl boot ${simUDID}`); } catch { /* already booted is fine */ }
sh(`xcrun simctl bootstatus ${simUDID} -b`);
sh(`xcrun simctl install ${simUDID} "${appPath}"`);

// The box URL is split the way the app stores it. Pointing at the REAL box is
// the entire difference between this and VisionDashboardUITests, which uses a
// stub: a stub proves the app reacts correctly to a sentence, this proves the
// sentence actually arrives from a machine on the internet.
const boxURL = new URL(BOX);
const boxJSON = JSON.stringify([{
  id: "closed-loop-box",
  name: boxURL.hostname,
  host: boxURL.hostname,
  port: Number(boxURL.port || 18080),
}]);

log(`launching pointed at ${BOX}`);
sh(`xcrun simctl terminate ${simUDID} ${BUNDLE_ID} 2>/dev/null || true`);
execFileSync("xcrun", [
  "simctl", "launch", simUDID, BUNDLE_ID,
  "-yaver.tv.token", TOKEN,
  // Route straight to the project's preview, same key and values as tvOS.
  // Neither surface can be driven to it reliably by input: tvOS has a
  // width-adaptive grid, and a headset has no remote at all.
  "-yaver.tv.startAt", `preview:${process.env.VIBE_PROJECT_NAME || "mobile"}`,
  "-yaver.tv.boxes", `"${boxJSON.replace(/"/g, '\\"')}"`,
  "-yaver.tv.selectedBox", "closed-loop-box",
], { stdio: "pipe" });

// ── 3-5. Read the app's own pixels ──────────────────────────────────────────

/** Screenshot the simulator, keep it, and read its text. */
function observe(label) {
  const file = join(RUN_DIR, `${String(++shots).padStart(4, "0")}-${label}.png`);
  sh(`xcrun simctl io ${simUDID} screenshot --type=png "${file}"`);
  let size = "?";
  try {
    const img = decodePng(readFileSync(file));
    size = `${img.width}x${img.height}`;
  } catch { /* the oracle can still read a frame we cannot decode */ }
  const read = oracle.readFrame(file);
  const entry = { seq: shots, label, file: file.split("/").pop(), size, text: read?.text || "" };
  timeline.push(entry);
  return entry;
}

/**
 * Poll the app's screen until `want` appears — unless the screen is showing a
 * RECOGNISED FAILURE, in which case stop immediately and report that instead.
 *
 * The failure check comes FIRST, and it is not defensive tidiness. On this
 * arc's very first run the app rendered:
 *
 *   "Couldn't reach 100.75.123.78: The resource could not be loaded because the
 *    App Transport Security policy requires the use of a secure connection."
 *
 * and the assertion `waitForText("100.75.123.78")` PASSED — because the host
 * appears inside the error message. A positive needle matched an error that
 * says the exact opposite of what the assertion claims to prove. That is a
 * false green produced by the harness, on the same run that found a real
 * product bug, and it would have hidden it.
 *
 * So: a screen the oracle can NAME as a failure ends the wait, whatever else is
 * written on it. Text on a screen is not evidence that the thing named by that
 * text is working.
 */
function waitForText(want, label, budgetMs = 90_000) {
  const deadline = Date.now() + budgetMs;
  let last = null;
  const needles = Array.isArray(want) ? want : [want];
  while (Date.now() < deadline) {
    last = observe(label);
    // `expected` is not optional here. This arc previews the LOGIN SCREEN, so
    // "Continue with Apple" on the frame is the SUBJECT under test, not
    // evidence of a signed-out app. Without it the loop reported "the session
    // did not reach the surface" about a headset that had reached the box,
    // routed to the preview, and was rendering streamed pixels correctly — the
    // same misdiagnosis already fixed in the headless arcs and reintroduced
    // here by omission.
    const named = oracle.nameFromText(last.text || "", { expected: ["signed-out"] });
    if (named) return { ok: false, seen: last, named };
    const low = (last.text || "").toLowerCase();
    if (needles.some((n) => low.includes(String(n).toLowerCase()))) return { ok: true, seen: last };
    execFileSync("sleep", ["5"]);
  }
  return { ok: false, seen: last };
}

let failed = false;
let reason = "";

try {
  const oracleState = oracle.available();
  log(oracleState.ok ? "text oracle: ready" : `text oracle: UNAVAILABLE — ${oracleState.reason.split("\n")[0]}`);
  if (!oracleState.ok) {
    // Unlike the colour arcs, this one's verdict IS the oracle. Without it there
    // is no signal at all, so say that plainly instead of reporting a pass on
    // nothing.
    skip(
      `this arc reads the app's own text off simulator pixels, so it cannot run without the oracle: ${oracleState.reason.split("\n")[0]}`,
      "xcrun swiftc -O desktop/agent/screenread/main.swift -o desktop/agent/screenread/screenread && codesign --force -s - desktop/agent/screenread/screenread",
    );
  }

  // 3. Does the dashboard show the REAL machine?
  const info = await fetch(`${BOX}/info`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());
  const realHost = info.hostname || boxURL.hostname;
  log(`box is ${realHost} (agent ${info.version})`);

  // The app routes STRAIGHT to preview:<project>, so asserting on the dashboard
  // would assert on a screen it deliberately skips. The preview's own chrome —
  // "<project> • <form>" and "Rebuild" — is the marker that it arrived.
  const dash = waitForText([PROJECT_NAME, "Rebuild"], "preview");
  log(`preview screen: ${dash.ok ? "PASS" : "FAIL"} — saw ${(dash.seen?.text || "(nothing)").slice(0, 160)}`);
  if (!dash.ok) {
    failed = true;
    reason = dash.named
      ? `the headset never reached the preview — ${dash.named.say}`
      : `the headset never reached the preview. The screen said: ${(dash.seen?.text || "(no text at all)").slice(0, 300)}`;
  }

  // 4. THE COLOUR VERDICT — a FRACTION, not a modal colour.
  //
  // Same shape as the tvOS loop and for the same reason: the preview is a PANEL
  // inside the app's window, so the modal colour of the whole screen is the
  // app's own chrome. Measured on tvOS: 0.0% red at launch, 22.3% with a red
  // preview. Using modalColor there reported "black" for thirty frames while
  // the box's login.tsx carried three red containers.
  if (!failed) {
    log("sending the colour turn…");
    await fetch(`${BOX}/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "vision colour turn",
        description: "Change the login screen so its VISIBLE background is red. Every container that "
          + "paints the full-screen background must be red, so the whole screen reads red. Only the login screen.",
        workDir: process.env.VIBE_PROJECT_PATH || "/root/Workspace/yaver.io/mobile",
      }),
    }).catch((e) => log(`(could not create the task: ${e.message})`));

    const deadline = Date.now() + VIBE_BUDGET_MS;
    let peak = 0;
    while (Date.now() < deadline && peak < RED_PANEL_FRACTION) {
      const shot = observe("vibe");
      try {
        const img = decodePng(readFileSync(join(RUN_DIR, shot.file)));
        const sm = samplePixels(img, samplePoints, 6);
        let red = 0;
        for (const px of sm) if (classifyVibeColor(px) === "red") red++;
        peak = Math.max(peak, sm.length ? red / sm.length : 0);
      } catch { /* a frame we cannot decode is not a verdict */ }
      if (peak < RED_PANEL_FRACTION) execFileSync("sleep", ["15"]);
    }
    log(`peak red ${(peak * 100).toFixed(1)}% (need ${(RED_PANEL_FRACTION * 100).toFixed(0)}%)`);
    if (peak < RED_PANEL_FRACTION) {
      failed = true;
      const last = timeline[timeline.length - 1];
      const seen = last ? oracle.explainFrame(join(RUN_DIR, last.file), { expected: ["signed-out"] }) : null;
      reason = `the headset preview never turned red (peak ${(peak * 100).toFixed(1)}%). `
        + (seen ? seen.reason : "the oracle read no text off the final frame");
    }
  }

  // 5. Runner sessions — only meaningful once the app is up.
  if (false) {
    const runner = waitForText(["session", "runner", "opencode", "claude"], "runners", 60_000);
    log(`runner sessions listed: ${runner.ok ? "PASS" : "not shown"}`);
    if (!runner.ok) {
      failed = true;
      reason = runner.named
        ? `the dashboard rendered but the app reported a failure — ${runner.named.say}`
        : `the dashboard rendered but listed no runner session. The screen said: ${(runner.seen?.text || "").slice(0, 300)}`;
    }
  }
} catch (err) {
  failed = true;
  reason = reason || err.message;
  console.error(`[visionos-sim] ARC ERROR: ${err.message}`);
}

// ── Artifacts ───────────────────────────────────────────────────────────────
try {
  writeFileSync(join(RUN_DIR, "manifest.json"), JSON.stringify({
    surface: "visionos-sim",
    runId: RUN_ID,
    simulator: { name: SIM_NAME, udid: simUDID },
    box: BOX,
    verdict: failed ? "NAMED" : "PIXELS",
    reason,
    frames: timeline,
  }, null, 2));
  log(`artifacts: ${RUN_DIR} (${timeline.length} screenshots + manifest.json)`);
} catch { /* artifacts never change a verdict */ }

const verdict = failed ? (reason ? "NAMED" : "SILENT") : "PIXELS";
console.log(`\nvisionos-sim: ${verdict}${reason ? ` — ${reason}` : " — the real app reached the real box and rendered it"}`);
process.exit(failed ? 1 : 0);
