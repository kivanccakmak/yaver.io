#!/usr/bin/env node
/**
 * android-emu-vibe-loop.mjs — the REAL Yaver Android app, in an emulator on this
 * Mac, previewing a project served by ubuntu-4gb, vibed black → RED.
 *
 *   YAVER_TEST_TOKEN=… npx tsx e2e/android-emu-vibe-loop.mjs
 *
 * Third surface in the same shape as tvOS and visionOS: the CLIENT is a
 * simulator/emulator on this machine, the REMOTE is the box's browser lane, and
 * the verdict is pixels read off the emulator's own screen.
 *
 * ── What is genuinely different about Android ──────────────────────────────
 *
 *  • The client is the RN app, not a SwiftUI one, so it reaches the box through
 *    the same transport the phone uses. That makes this the first of the three
 *    loops whose client shares code with the shipped mobile app.
 *  • A RELEASE apk is used deliberately. A debug RN build needs Metro to serve
 *    JS, and the app under test must depend on the BOX and nothing else — a
 *    loop that quietly requires a local bundler is testing this laptop.
 *  • `adb exec-out screencap -p` is the screenshot, and it decodes with the
 *    same e2e/_framePixels.mjs the other surfaces use (verified: 1080x2400).
 *
 * ── The threshold is MEASURED here, never borrowed ─────────────────────────
 *
 * The same red preview reads differently on every surface, because the panel is
 * the same and the screen around it is not:
 *
 *   tvOS      1920x1080 screenshot   → 22.3% red   (threshold 8%)
 *   visionOS  3840x2160 screenshot   →  6.5% red   (threshold 3%)
 *
 * Borrowing the tvOS number failed a WORKING visionOS run by 1.5 points today.
 * So this file does not ship a guessed constant: it records a baseline before
 * the vibe and requires a clear step above it. A relative jump is the honest
 * discriminator when the absolute value depends on a screen size nobody has
 * measured yet.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyVibeColor, looksRendered, samplePoints, verdictFor } from "../web/lib/vibeVerdict.ts";
import { decodePng, samplePixels } from "./_framePixels.mjs";
import * as oracle from "./_visionOracle.mjs";

const TOKEN = process.env.YAVER_TEST_TOKEN || "";

// The box address has NO DEFAULT, deliberately.
//
// It used to fall back to one machine's tailnet IP. That is the single-user bug
// CLAUDE.md forbids wearing a test's clothes: every arc silently targeted one
// person's box, so anyone else's run measured a machine they do not own, and a
// real overlay address sat in a PUBLIC repo. Unset is unset — say so and skip.
const BOX = process.env.VIBE_BOX_HOST || "";
const PROJECT = process.env.VIBE_PROJECT_NAME || "mobile";
const WORKDIR = process.env.VIBE_PROJECT_PATH || "/root/Workspace/yaver.io/mobile";
const PKG = process.env.ANDROID_PKG || "io.yaver.mobile";
const SDK = process.env.ANDROID_SDK_ROOT || `${process.env.HOME}/.yaver/runtimes/android-sdk`;
const ADB = join(SDK, "platform-tools", "adb");
const RUN_ID = process.env.LOOP_RUN_ID || new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = new URL(`./test-results/loops/${RUN_ID}/android-emu/`, import.meta.url).pathname;
const BUDGET_MS = Number(process.env.VIBE_BUDGET_MS || 10 * 60_000);

/**
 * How much the red fraction must RISE above its own baseline to count.
 *
 * Relative, not absolute — see the header. 2.5 points is comfortably above
 * frame-to-frame noise (the other surfaces held their level to within 0.1
 * across fifteen consecutive frames) and far below the smallest real signal
 * measured anywhere (6.5% on visionOS).
 */
const RED_RISE = Number(process.env.ANDROID_RED_RISE || 0.025);

const log = (m) => console.log(`[android-emu] ${m}`);
const h = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function skip(reason, remedy) {
  console.log(`\n[android-emu] SKIP — ${reason}`);
  if (remedy) console.log(`[android-emu] fix: ${remedy}`);
  console.log("\nandroid-emu: SKIPPED (NAMED)");
  process.exit(0);
}

function adb(args, opts = {}) {
  return execFileSync(ADB, args, { encoding: "utf8", ...opts });
}

async function api(path, init = {}) {
  const res = await fetch(`${BOX}${path}`, { ...init, headers: { ...h, ...(init.headers || {}) } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${init.method || "GET"} ${path} → HTTP ${res.status}${body ? `: ${body.slice(0, 250)}` : ""}`);
  }
  return res.headers.get("content-type")?.includes("json") ? res.json() : res.arrayBuffer();
}

if (!BOX) skip("set VIBE_BOX_HOST (e.g. http://<your-box>:18080)",
  "yaver devices — then use that machine's reachable address");
if (!TOKEN) skip("set YAVER_TEST_TOKEN (a session token for the box's owner)");
if (!existsSync(ADB)) skip(`adb not found at ${ADB}`, "install the Android SDK platform-tools");

// ── 0. Emulator + app present ───────────────────────────────────────────────
let devices = "";
try {
  devices = adb(["devices"]);
} catch (err) {
  skip(`adb could not list devices: ${err.message}`);
}
if (!/emulator-\d+\s+device/.test(devices)) {
  skip("no booted Android emulator",
    `${join(SDK, "emulator", "emulator")} -avd yaver-loop -no-window -no-audio -no-boot-anim`);
}
try {
  if (!adb(["shell", "pm", "list", "packages", PKG]).includes(PKG)) {
    skip(`${PKG} is not installed on the emulator`,
      "cd mobile/android && ./gradlew assembleRelease && adb install -r app/build/outputs/apk/release/app-release.apk");
  }
} catch (err) {
  skip(`could not query installed packages: ${err.message}`);
}

// ── 1. The box's browser lane has to be up ─────────────────────────────────
const info = await api("/info").catch((e) => skip(`the box did not answer: ${e.message}`));
log(`box ${info.hostname} · agent ${info.version}`);
const ds = info.devServer || {};
if (!ds.webPort) {
  log("booting the web preview on the box…");
  await api("/dev/web-preview/start", { method: "POST", body: "{}" })
    .catch((e) => skip(`could not start the web preview: ${e.message}`));
}

// ── 2. Launch the app ───────────────────────────────────────────────────────
mkdirSync(RUN_DIR, { recursive: true });
log(`launching ${PKG}`);
try {
  adb(["shell", "am", "force-stop", PKG]);
  // `am start` with the RESOLVED launcher activity, not `monkey`.
  //
  // monkey exits non-zero on harmless diagnostics — "** SYS_KEYS has no
  // physical keys but with factor 2.0%" is a warning, and it skipped this arc
  // on its first run as if the app could not be launched. A launcher that
  // reports failure for a working launch is the same false signal this suite
  // exists to remove, so the launch is resolved and invoked directly.
  const resolved = adb(["shell", "cmd", "package", "resolve-activity", "--brief", PKG])
    .trim().split("\n").pop().trim();
  if (!resolved.includes("/")) {
    skip(`could not resolve a launcher activity for ${PKG} (got ${JSON.stringify(resolved)})`,
      "check the APK actually declares an android.intent.category.LAUNCHER activity");
  }
  log(`launcher: ${resolved}`);
  adb(["shell", "am", "start", "-n", resolved]);
} catch (err) {
  skip(`could not launch ${PKG}: ${err.message}`);
}
await sleep(20_000);

let shots = 0;
const timeline = [];

/** Screenshot the emulator and measure it. */
function observe(label) {
  const file = `${String(++shots).padStart(4, "0")}-${label}.png`;
  const path = join(RUN_DIR, file);
  try {
    const png = execFileSync(ADB, ["exec-out", "screencap", "-p"], { maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(path, png);
  } catch (err) {
    timeline.push({ file, error: err.message });
    return null;
  }
  let entry = { seq: shots, file, label };
  try {
    const img = decodePng(readFileSync(path));
    const sm = samplePixels(img, samplePoints, 6);
    let red = 0;
    for (const px of sm) if (classifyVibeColor(px) === "red") red++;
    entry = {
      ...entry,
      size: `${img.width}x${img.height}`,
      redFraction: Number(((red / sm.length) * 100).toFixed(1)),
      rendered: looksRendered(sm),
    };
  } catch (err) {
    entry.decodeError = err.message;
  }
  timeline.push(entry);
  return entry;
}

let failed = false;
let reason = "";

try {
  const o = oracle.available();
  log(o.ok ? "text oracle: ready" : `text oracle: unavailable — ${o.reason.split("\n")[0]}`);

  const first = observe("launch");
  log(`launch frame ${first?.size || "?"} · red ${first?.redFraction ?? "?"}% · rendered=${first?.rendered}`);

  // READ THE FIRST FRAME BEFORE SPENDING THE BUDGET.
  //
  // The first run of this arc polled a SIGN-IN SCREEN for ten minutes and then
  // reported "the Android preview never turned red" — technically true, and a
  // useless thing to say about an app that was never signed in. The oracle
  // could read "Continue with Apple | Continue with Google | …" off frame 1,
  // so the answer existed at second twenty and the arc waited six hundred more
  // to give it.
  //
  // That is the same defect the whole suite exists to remove, committed by the
  // suite: an unfalsifiable wait in front of a fact already in hand. Anything
  // the oracle can name at launch is named at launch, and the run stops.
  //
  // Deliberately a SKIP, not a failure: a signed-out emulator is a missing
  // precondition, not a product regression, and reporting it red is how a
  // suite trains its readers to ignore it.
  const atLaunch = oracle.explainFrame(join(RUN_DIR, first.file));
  if (atLaunch?.cause === "signed-out") {
    skip("the Yaver app on the emulator is SIGNED OUT — no preview can exist, so no colour verdict is possible",
      "sign the emulator's app in (adb shell am start … the login screen), then re-run");
  }
  if (atLaunch?.cause === "box-unreachable" || atLaunch?.cause === "ats-blocked") {
    skip(`the app cannot reach the box: ${atLaunch.reason}`,
      "check VIBE_BOX_HOST is reachable FROM THE EMULATOR (10.0.2.2 is the host, not the box)");
  }

  // BASELINE BEFORE THE VIBE. The absolute red fraction depends on how much of
  // this screen the preview occupies, which is a per-surface number nobody has
  // measured for an emulator. A RISE above the screen's own baseline is the
  // honest discriminator — see the header for what borrowing a constant cost.
  const baseline = (first?.redFraction ?? 0) / 100;

  log("sending the colour turn…");
  await api("/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: "android colour turn",
      description: "Change the login screen so its VISIBLE background is red. Every container that paints "
        + "the full-screen background must be red, so the whole screen reads red. Only the login screen.",
      workDir: WORKDIR,
    }),
  }).catch((e) => log(`(could not create the task: ${e.message})`));

  const deadline = Date.now() + BUDGET_MS;
  let peak = baseline;
  while (Date.now() < deadline && peak - baseline < RED_RISE) {
    await sleep(20_000);
    const s = observe("vibe");
    if (s?.redFraction != null) peak = Math.max(peak, s.redFraction / 100);
  }

  const rise = peak - baseline;
  log(`baseline ${(baseline * 100).toFixed(1)}% → peak ${(peak * 100).toFixed(1)}% (rise ${(rise * 100).toFixed(1)}pp, need ${(RED_RISE * 100).toFixed(1)}pp)`);
  if (rise < RED_RISE) {
    failed = true;
    const last = timeline.filter((t) => t.file).pop();
    const seen = last ? oracle.explainFrame(join(RUN_DIR, last.file), { expected: ["signed-out"] }) : null;
    reason = `the Android preview never turned red (rise ${(rise * 100).toFixed(1)}pp). `
      + (seen ? seen.reason : "the oracle read no text off the final frame");
  }
} catch (err) {
  failed = true;
  reason = reason || err.message;
  console.error(`[android-emu] ARC ERROR: ${err.message}`);
}

try {
  writeFileSync(join(RUN_DIR, "manifest.json"), JSON.stringify({
    surface: "android-emu", runId: RUN_ID, box: BOX, project: PROJECT, pkg: PKG,
    verdict: failed ? "NAMED" : "PIXELS", reason, frames: timeline,
  }, null, 2));
  log(`artifacts: ${RUN_DIR} (${timeline.length} frames + manifest.json)`);
} catch { /* artifacts never change a verdict */ }

const { verdict, reason: verdictReason } = verdictFor({
  reachedTarget: !failed, reverted: !failed, reason,
});
console.log(`\nandroid-emu: ${verdict} — ${verdictReason}`);
process.exit(verdict === "PIXELS" ? 0 : 1);
