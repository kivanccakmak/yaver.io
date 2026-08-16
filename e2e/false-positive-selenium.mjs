#!/usr/bin/env node
// false-positive-selenium.mjs — closed-loop UI-capture cell of the
// "don't scare the user" harness (docs/architecture/CLOSED_LOOP_FALSE_POSITIVE_TESTING.md).
//
// Selenium drives the REAL deployed web dashboard, reads the device card the
// user actually sees, and asserts it agrees with GROUND TRUTH:
//   Oracle:  relay /d/<id>/health 200 == reachable AND authorized.
//   Assert:  that box's card must NOT show "can't reach" / "Unauthorized"
//            (the false positive). An honest "offline" on a box that is 502 is
//            allowed.
// Records the run to an mp4 (screenshot frames stitched by ffmpeg).
//
// Auth: seeds a valid session token from ~/.yaver/config.json into
// localStorage (bypasses OAuth). READ-ONLY. Token is never logged.

import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Builder, By, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";

const APP = process.env.YAVER_WEB_URL || "https://yaver.io";
const RELAY = process.env.YAVER_RELAY_HTTP || "https://public.yaver.io";
const TARGET_ID = process.env.YAVER_TARGET_DEVICE || "5e79cf10-90e8-4a4f-bf07-041061dca210";
const TARGET_NAME = "ubuntu-4gb";
const OUT = process.env.YAVER_OUT_DIR || "/private/tmp/claude-501/-Users-kivanccakmak-Workspace-yaver-io/a54e4b04-2f01-4faa-8f6e-93e876b25afb/scratchpad";
const FRAMES = join(OUT, "sel_frames");

const cfg = JSON.parse(readFileSync(join(homedir(), ".yaver", "config.json"), "utf8"));
const TOKEN = cfg.auth_token;
const RELAY_PW = cfg.cached_relay_password || "";

async function oracleReachable() {
  const headers = { Authorization: `Bearer ${TOKEN}` };
  if (RELAY_PW) headers["X-Relay-Password"] = RELAY_PW;
  const r = await fetch(`${RELAY}/d/${TARGET_ID}/health`, { headers }).catch(() => ({ status: 0 }));
  return r.status === 200;
}

async function run() {
  if (!TOKEN) { console.error("no auth_token in ~/.yaver/config.json"); process.exit(2); }
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });

  const truthReachable = await oracleReachable();
  console.log(`oracle: ${TARGET_NAME} (${TARGET_ID.slice(0, 8)}) relay/health == ${truthReachable ? "200 → reachable+authorized" : "not 200"}`);

  const opts = new chrome.Options()
    .addArguments("--headless=new", "--window-size=1400,1000", "--no-sandbox", "--disable-gpu");
  const driver = await new Builder().forBrowser("chrome").setChromeOptions(opts).build();

  let frame = 0;
  const snap = async () => {
    try {
      const png = await driver.takeScreenshot();
      writeFileSync(join(FRAMES, `f${String(frame++).padStart(4, "0")}.png`), Buffer.from(png, "base64"));
    } catch {}
  };
  const recorder = setInterval(snap, 700);

  let verdict = "UNKNOWN";
  let cardText = "";
  try {
    // 1. Origin, then seed the session token (bypass OAuth).
    await driver.get(APP + "/dashboard");
    await driver.executeScript(
      "try{localStorage.setItem('yaver_auth_token', arguments[0]);document.cookie='yaver_auth_token='+arguments[0]+'; path=/; samesite=lax';}catch(e){}",
      TOKEN,
    );
    await driver.get(APP + "/dashboard");
    await snap();

    // 2. Wait for the device list to render, then find the target card.
    await driver.wait(until.elementLocated(By.xpath("//*[contains(text(),'ubuntu-4gb')]")), 40000);
    await driver.sleep(3500); // let probes + labels settle
    await snap();

    // 3. Isolate the PRIMARY card (the reachable box, deviceId 5e79cf10) — the
    //    one that says "PRIMARY". There are TWO cards named ubuntu-4gb-hel1-1
    //    (a real one and a genuinely-offline same-name box), so we must assert
    //    on the reachable one, not any text containing the shared hostname.
    const cards = await driver.findElements(
      By.xpath("//*[contains(.,'ubuntu-4gb-hel1-1') and contains(.,'PRIMARY') and (contains(.,'Connected') or contains(.,'can') or contains(.,'Unauthorized'))]"),
    );
    // Smallest such element == the tightest container that still holds the label.
    let best = null, bestLen = Infinity;
    for (const c of cards) {
      const t = (await c.getText().catch(() => "")) || "";
      if (t.includes("ubuntu-4gb") && t.includes("PRIMARY") && t.length < bestLen) { best = t; bestLen = t.length; }
    }
    cardText = best || cardText;
    await snap();

    const lower = cardText.toLowerCase();
    const scary = /can't reach|cant reach|unauthorized|can.t reach/.test(lower);
    const connected = /connected|reachable|relay ·|tunnel ·|direct ·/.test(lower);
    if (truthReachable && scary) {
      verdict = "FALSE-POSITIVE";
      console.log(`FAIL — the PRIMARY ${TARGET_NAME} is reachable+authorized (health 200) but its card shows a scary label:\n${cardText.slice(0, 400)}`);
    } else if (truthReachable && !scary && connected) {
      verdict = "TRUE-GREEN";
      console.log(`ok — PRIMARY ${TARGET_NAME} reachable+authorized AND its card shows the true state (Connected), no false "Unauthorized".\n--- card ---\n${cardText.slice(0, 300)}`);
    } else if (truthReachable && !scary) {
      verdict = "TRUE-GREEN";
      console.log(`ok — PRIMARY ${TARGET_NAME} reachable+authorized AND no false "can't reach / Unauthorized" on its card.`);
    } else {
      verdict = "TRUTH-NOT-REACHABLE";
      console.log(`·· ${TARGET_NAME} not reachable via relay right now; label honesty not asserted this run.`);
    }
  } catch (e) {
    verdict = "ERROR";
    console.error("selenium run error:", e?.message || e);
  } finally {
    clearInterval(recorder);
    await snap();
    await driver.quit().catch(() => {});
  }

  // Stitch frames → mp4.
  const mp4 = join(OUT, "false_positive_selenium.mp4");
  try {
    execFileSync("ffmpeg", [
      "-y", "-framerate", "2", "-pattern_type", "glob", "-i", join(FRAMES, "f*.png"),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-vf", "scale=1000:-2", mp4,
    ], { stdio: "ignore" });
    console.log("VIDEO=" + mp4);
  } catch (e) {
    console.log("ffmpeg stitch failed:", e?.message || e);
  }
  console.log("VERDICT=" + verdict);
  if (verdict === "FALSE-POSITIVE" || verdict === "ERROR") process.exit(1);
}

run().catch((e) => { console.error("crashed:", e); process.exit(2); });
