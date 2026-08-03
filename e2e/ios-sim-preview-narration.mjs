#!/usr/bin/env node
/**
 * ios-sim-preview-narration.mjs — the REAL Yaver iOS app, in the iPhone
 * simulator on this Mac, previewing sfmg served by the REAL remote box.
 *
 *   VIBE_BOX_HOST=http://<box>:18080 YAVER_TEST_TOKEN=… \
 *     node e2e/ios-sim-preview-narration.mjs
 *
 * ── Why this exists ALONGSIDE the RN-web arc ───────────────────────────────
 *
 * The RN-web arc (tests/sfmg-preview-narration.spec.ts) gets the real app
 * signed in against the real box in seconds, and that is the right first
 * layer. But it could not open the preview: `<Modal presentationStyle=
 * "fullScreen">` wrapping a `react-native-webview` is the one part of this
 * screen with no honest web equivalent, so RN-web cannot answer whether the
 * wait panel renders where the user actually saw a black rectangle.
 *
 * That is a real limit, not a flake, and the answer to a limit is the surface
 * that does not have it. This arc drives the compiled iOS app in the
 * simulator, reads PIXELS and on-screen TEXT off the simulator's own screen,
 * and never asks the app what it thinks it is showing.
 *
 * ── The defect under test ──────────────────────────────────────────────────
 *
 * TestFlight build 500, 2026-08-03: sfmg's preview was solid black for two
 * minutes — no elapsed time, no status, no name of what was running — while
 * the box was healthy and printing progress the whole time. Then it rendered
 * fine. "the ux ui plumbing is not good, user wont feel that its going well at
 * some stages."
 *
 * The verdict here is therefore about the WAIT, not the destination:
 *   NARRATED — during the blank interval the screen said what was running and
 *              for how long.
 *   SILENT   — it did not. This is the only failing verdict.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as oracle from "./_visionOracle.mjs";

const BOX = process.env.VIBE_BOX_HOST || "";
const TOKEN = process.env.YAVER_TEST_TOKEN || "";
const PROJECT = process.env.VIBE_PROJECT_NAME || "sfmg";
const UDID = process.env.IOS_SIM_UDID || "";
const BUNDLE = process.env.IOS_BUNDLE_ID || "io.yaver.mobile";
const RUN_ID = process.env.LOOP_RUN_ID || "ios-sim";
const RUN_DIR = new URL(`./test-results/loops/${RUN_ID}/ios-sim/`, import.meta.url).pathname;
const BUDGET_MS = Number(process.env.VIBE_BUDGET_MS || 4 * 60_000);

const log = (m) => console.log(`[ios-sim] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function skip(reason, remedy) {
  console.log(`\n[ios-sim] SKIP — ${reason}`);
  if (remedy) console.log(`[ios-sim] fix: ${remedy}`);
  console.log("\nios-sim: SKIPPED (NAMED)");
  process.exit(0);
}

function simctl(args, opts = {}) {
  return execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8", ...opts });
}

if (!BOX) skip("set VIBE_BOX_HOST (e.g. http://<your-box>:18080)");
if (!TOKEN) skip("set YAVER_TEST_TOKEN (a session token for the box's owner)");

// ── 0. A booted simulator with the app installed ────────────────────────────
let udid = UDID;
if (!udid) {
  const booted = simctl(["list", "devices", "booted"]);
  const m = booted.match(/iPhone[^(]*\(([0-9A-F-]{36})\)/i);
  if (!m) skip("no booted iPhone simulator", "xcrun simctl boot <udid>");
  udid = m[1];
}
log(`simulator ${udid}`);

try {
  simctl(["get_app_container", udid, BUNDLE]);
} catch {
  skip(`${BUNDLE} is not installed on this simulator`,
    "cd mobile && npx expo run:ios --scheme Yaver --device <udid>");
}

mkdirSync(RUN_DIR, { recursive: true });

let shots = 0;
const timeline = [];

/** Photograph the SIMULATOR SCREEN and read the text off it. */
function observe(label) {
  const file = `${String(++shots).padStart(4, "0")}-${label}.png`;
  const path = join(RUN_DIR, file);
  try {
    simctl(["io", udid, "screenshot", path]);
  } catch (err) {
    timeline.push({ file, error: err.message });
    return { file, text: "" };
  }
  // The oracle reads what a VIEWER would read — never what the app reports
  // about itself. A surface without a DOM still has to be judged on pixels.
  let text = "";
  try {
    text = oracle.textOf ? oracle.textOf(path) : (oracle.explainFrame(path)?.text || "");
  } catch { /* an unreadable frame is not a verdict */ }
  const entry = { seq: shots, file, label, text: text.slice(0, 400) };
  timeline.push(entry);
  return { file, text };
}

let verdict = "SILENT";
let reason = "";

try {
  log(`launching ${BUNDLE}`);
  try { simctl(["terminate", udid, BUNDLE]); } catch { /* not running */ }
  simctl(["launch", udid, BUNDLE]);
  await sleep(15_000);

  const first = observe("launch");
  log(`launch frame read ${first.text.length} chars`);

  // CHECKED ON EVERY FRAME, NOT JUST THE FIRST.
  //
  // The first run of this arc checked only the launch frame, and at 15s the app
  // was still on its splash. It reached the sign-in screen a few seconds later,
  // sat there for the whole budget, and the arc concluded "SILENT — this is the
  // build-500 defect" about an app that was never signed in and could not have
  // shown a preview at all.
  //
  // A false RED is exactly as corrosive as a false green, and this suite has
  // now produced one on both surfaces. Any state that makes the verdict
  // MEANINGLESS has to be detected wherever it appears, not at one sample.
  const signedOut = (t) => /continue with apple|continue with google|sign in with/i.test(t || "");
  if (signedOut(first.text)) {
    skip("the simulator's Yaver is SIGNED OUT — no preview can exist, so there is no wait to judge",
      "sign in once in the simulator (note: auth.ts wipes a seeded token when the `yaver_installed` "
      + "flag is absent — both must be present)");
  }

  // ── The assertion this arc exists for ───────────────────────────────────
  //
  // Watch the interval the user watched. At some point during it the screen
  // must state what is running and how long it has been going.
  log(`watching for narration on the preview (budget ${Math.round(BUDGET_MS / 1000)}s)…`);
  const deadline = Date.now() + BUDGET_MS;
  let sawElapsed = false;
  let sawWhat = "";
  while (Date.now() < deadline && !sawElapsed) {
    await sleep(5_000);
    const s = observe("watch");
    if (signedOut(s.text)) {
      skip("the app dropped to the SIGN-IN screen mid-run — no preview exists, so there is no wait "
        + "to judge (it was NOT silent; it was signed out)",
        "sign in once in the simulator, then re-run");
    }
    if (/\d+(:\d\d)?s?\s+elapsed/i.test(s.text)) {
      sawElapsed = true;
      sawWhat = s.text.replace(/\s+/g, " ").slice(0, 200);
    }
  }

  if (sawElapsed) {
    verdict = "NARRATED";
    reason = `the preview stated its progress on screen: "${sawWhat}"`;
  } else {
    const last = timeline.filter((t) => t.text).pop();
    reason = "no elapsed-time narration ever appeared while the preview was blank — this is the "
      + "build-500 defect. Last text read off the screen: "
      + (last ? JSON.stringify(last.text.slice(0, 200)) : "(the oracle read nothing at all)");
  }
} catch (err) {
  reason = `arc error: ${err.message}`;
}

try {
  writeFileSync(join(RUN_DIR, "manifest.json"), JSON.stringify({
    surface: "ios-sim", runId: RUN_ID, box: BOX, project: PROJECT,
    bundle: BUNDLE, udid, verdict, reason, frames: timeline,
  }, null, 2));
  log(`artifacts: ${RUN_DIR} (${timeline.length} frames + manifest.json)`);
} catch { /* artifacts never change a verdict */ }

console.log(`\nios-sim: ${verdict} — ${reason}`);
process.exit(verdict === "NARRATED" ? 0 : 1);
