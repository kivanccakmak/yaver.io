#!/usr/bin/env node
// run.mjs [web|mobile] — run the vibe closed-loop scenario on a surface + record.
// docs/architecture/E2E_VIBE_CLOSED_LOOP_ALL_SURFACES.md.
//
// Env: YAVER_TEST_EMAIL / YAVER_TEST_PASSWORD (never logged/committed).
//      VIBE_PHASE=baseline stops after the baseline read (fast selector check).
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Builder } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import { runScenario, classifyColor } from "./scenario.mjs";
import { makeWebAdapter } from "./adapters/web.mjs";
import { makeMobileAdapter } from "./adapters/mobile.mjs";

const SURFACE = process.argv[2] || "web";
const PHASE = process.env.VIBE_PHASE || "full";
// Target colour for the vibe. Red by default now: the owner asked for red, and
// red is also further from every failure artefact than green (a decoder with no
// content paints rgb(0,135,0)).
const TARGET_COLOR = process.env.VIBE_COLOR || "red";
const OUT = process.env.YAVER_OUT_DIR || "/private/tmp/claude-501/-Users-kivanccakmak-Workspace-yaver-io/a54e4b04-2f01-4faa-8f6e-93e876b25afb/scratchpad";
const FRAMES = join(OUT, `vibe_${SURFACE}_frames`);

async function main() {
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });

  const width = SURFACE === "mobile" ? 420 : 1440;
  const height = SURFACE === "mobile" ? 900 : 1000;
  const opts = new chrome.Options().addArguments(`--window-size=${width},${height}`, "--no-sandbox", "--disable-gpu");
  if (process.env.HEADED !== "1") opts.addArguments("--headless=new");
  const driver = await new Builder().forBrowser("chrome").setChromeOptions(opts).build();

  const adapter = SURFACE === "mobile"
    ? makeMobileAdapter(driver, FRAMES)
    : SURFACE === "web"
      ? makeWebAdapter(driver, FRAMES)
      : (() => { throw new Error(`no adapter for ${SURFACE}`); })();

  let result;
  try {
    if (PHASE === "baseline") {
      console.log(`vibe-e2e [${SURFACE}] · phase=baseline (login→connect→vibing→baseline)`);
      await adapter.login(); console.log("  ok  login");
      const c = await adapter.ensureConnectedToPrimary(); console.log(`  ${c.ok ? "ok" : "FAIL"}  connect — ${c.detail || c.reason}`);
      await adapter.openVibing(); console.log("  ok  openVibing");
      await adapter.selectProject(); console.log("  ok  selectProject");
      await adapter.renderPreview(); console.log("  ok  renderPreview");
      const bg = await adapter.readPreviewBackground();
      console.log(`  baseline background: ${bg} → ${classifyColor(bg)}`);
      result = { verdict: c.ok ? "PHASE-OK" : "NAMED", reason: c.ok ? "reached baseline" : c.reason };
    } else {
      console.log(`vibe-e2e [${SURFACE}] · phase=full (black→green→black)`);
      result = await runScenario(adapter, { targetColor: TARGET_COLOR });
    }
  } catch (e) {
    result = { verdict: "SILENT", reason: `crashed: ${e?.message || e}` };
  } finally {
    await adapter.snap("final").catch(() => {});
    await driver.quit().catch(() => {});
  }

  // Stitch → mp4.
  const mp4 = join(OUT, `vibe_${SURFACE}.mp4`);
  try {
    execFileSync("ffmpeg", ["-y", "-framerate", "2", "-pattern_type", "glob", "-i", join(FRAMES, "f*.png"),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-vf", "scale=900:-2", mp4], { stdio: "ignore" });
    console.log("VIDEO=" + mp4);
  } catch {}
  console.log(`VERDICT=${result.verdict}${result.reason ? " · " + result.reason : ""}`);
  process.exit(result.verdict === "PIXELS" || result.verdict === "PHASE-OK" ? 0 : 1);
}

main().catch((e) => { console.error("fatal:", e); process.exit(2); });
