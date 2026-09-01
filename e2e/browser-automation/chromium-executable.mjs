import { constants, promises as fs } from "node:fs";
import process from "node:process";

async function playwrightChromium() {
  const playwright = await import("@playwright/test");
  return playwright.chromium;
}

async function executable(pathname) {
  if (!pathname) return false;
  try {
    await fs.access(pathname, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Keep browser discovery shared by the queue launcher and executable specs.
// Playwright can have a full managed Chromium installed while its separate
// headless-shell binary is absent; chromium.launch() then fails before the
// product arc starts even though a usable system browser is already present.
export async function resolveChromiumExecutable() {
  if (process.env.YAVER_CHROMIUM_PATH) {
    if (!await executable(process.env.YAVER_CHROMIUM_PATH)) {
      throw new Error("YAVER_CHROMIUM_PATH does not point to an available executable");
    }
    return process.env.YAVER_CHROMIUM_PATH;
  }

  const candidates = [
    ...(process.platform === "darwin" ? [
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ] : []),
    ...(process.platform === "linux" ? [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
    ] : []),
  ];
  // A missing optional test dependency must not conceal the actionable target
  // or browser-path error. Managed Chromium is simply one candidate among the
  // installed system browsers.
  try {
    candidates.unshift((await playwrightChromium()).executablePath());
  } catch {}
  for (const candidate of candidates) {
    if (await executable(candidate)) return candidate;
  }
  throw new Error("no Chromium executable is available; install Playwright Chromium or set YAVER_CHROMIUM_PATH");
}

export async function launchChromium(options = {}) {
  const executablePath = await resolveChromiumExecutable();
  const chromium = await playwrightChromium();
  return chromium.launch({ ...options, executablePath });
}
