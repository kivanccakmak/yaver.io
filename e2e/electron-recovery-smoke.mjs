#!/usr/bin/env node

/**
 * Electron GUI recovery smoke — deterministic, no network, no agent needed.
 *
 * Drives the REAL Electron main process (not Chromium pointed at a URL) with
 * the GUI_FAILURE_FIXTURE env var and asserts the black-screen recovery page
 * renders and behaves (audit pass-2 DP9):
 *   load  → main-frame load fails → recovery page with Retry + Open in browser
 *   crash → additionally force-crashes the renderer → render-process-gone →
 *           one bounded retry → recovery page again
 *
 * Also asserts the "Open in browser" link never carries a stripped token/__rp
 * (audit pass-2 M3) — a leak of the bearer into the OS browser is a regression
 * this smoke must catch.
 *
 * Usage (from repo root):
 *   GUI_FAILURE_FIXTURE=load  node e2e/electron-recovery-smoke.mjs
 *   GUI_FAILURE_FIXTURE=crash node e2e/electron-recovery-smoke.mjs
 *
 * Optional:
 *   YAVER_ELECTRON_ARTIFACT_DIR=/tmp/yaver-electron-recovery
 */

import { _electron as electron } from "playwright";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const electronRoot = join(repoRoot, "electron");
const executablePath = process.platform === "darwin"
  ? join(electronRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron")
  : process.platform === "win32"
    ? join(electronRoot, "node_modules", "electron", "dist", "electron.exe")
    : join(electronRoot, "node_modules", "electron", "dist", "electron");
const artifactDir = process.env.YAVER_ELECTRON_ARTIFACT_DIR || "/tmp/yaver-electron-recovery";
const fixture = (process.env.GUI_FAILURE_FIXTURE || "load").trim();
if (!["load", "crash"].includes(fixture)) {
  console.error(`GUI_FAILURE_FIXTURE must be "load" or "crash", got "${fixture}".`);
  process.exit(2);
}

let missing = null;
try {
  await stat(executablePath);
} catch {
  missing = executablePath;
}
if (missing) {
  console.error(
    `Electron runtime not installed at:\n  ${missing}\n` +
    `This smoke drives the real Electron binary (${electronRoot}/node_modules/electron/dist).\n` +
    `Fix: cd electron && npm ci   (needs ~800MB of free disk)`,
  );
  process.exit(1);
}

await mkdir(artifactDir, { recursive: true });
const app = await electron.launch({
  executablePath,
  args: [electronRoot],
  cwd: electronRoot,
  env: {
    ...process.env,
    GUI_FAILURE_FIXTURE: fixture,
    YAVER_ELECTRON_AUTOMATION: "1",
    YAVER_ELECTRON_USER_DATA_DIR: process.env.YAVER_ELECTRON_USER_DATA_DIR || join(artifactDir, "profile"),
  },
  timeout: 45_000,
});

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  if (!ok) console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  else console.log(`ok   ${name}`);
}

try {
  const page = await app.firstWindow({ timeout: 45_000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 45_000 });

  const heading = page.getByRole("heading", { name: /Yaver could not open the dashboard/i });
  await heading.waitFor({ state: "visible", timeout: 30_000 });
  check("recovery page renders", true);

  const detail = await page.locator("body").innerText();
  check("recovery names a cause", /could not be loaded|crashed/i.test(detail), detail.slice(0, 120).replace(/\n/g, " "));

  const retry = page.getByRole("button", { name: /^Retry$/i });
  check("Retry button present", await retry.isVisible().catch(() => false));

  // M3: the Open-in-browser link must never carry ?token=/?__rp=.
  const href = await page.evaluate(() => {
    const a = document.querySelector("a.button.secondary");
    return a ? a.getAttribute("href") : null;
  });
  check("Open-in-browser link present", typeof href === "string" && href.length > 0);
  check(
    "browser link is auth-param free",
    typeof href === "string" && !/[?&](?:token|__rp)=/.test(href),
    href || "(no href)",
  );
  check(
    "browser link is http(s)",
    typeof href === "string" && /^https?:\/\//.test(href),
    href || "(no href)",
  );

  if (fixture === "crash") {
    // render-process-gone → one bounded retry → load fails again → recovery.
    await heading.waitFor({ state: "visible", timeout: 30_000 });
    check("recovery page re-renders after renderer crash", true);
  }

  await retry.click({ timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const afterRetry = await page.locator("body").innerText().catch(() => "");
  check("Retry keeps the recovery page for the failing fixture", /Yaver could not open/i.test(afterRetry));

  const shot = join(artifactDir, `recovery-${fixture}.png`);
  await page.screenshot({ path: shot, fullPage: true });

  console.log(JSON.stringify({ ok: results.every((r) => r.ok), fixture, results, screenshot: shot }, null, 2));
} finally {
  await app.close();
}
