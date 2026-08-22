import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "@playwright/test";

const root = path.dirname(fileURLToPath(import.meta.url));
const queueRoot = path.join(root, "test-cases");
const target = process.env.MOBILE_WEB_URL;
const date = new Intl.DateTimeFormat("en-CA", {
  timeZone: process.env.TZ || "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const profile = process.env.E2E_PROFILE || path.join(os.homedir(), `.yaver-e2e-profile-browser-automation-${date}`);
const lockPath = path.join(os.homedir(), ".yaver-browser-automation-session.lock");
const iphone = devices["iPhone 15 Pro"];

async function executable(pathname) {
  if (!pathname) return false;
  try {
    await fs.access(pathname, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveChromiumExecutable() {
  if (process.env.YAVER_CHROMIUM_PATH) {
    if (!await executable(process.env.YAVER_CHROMIUM_PATH)) {
      throw new Error("YAVER_CHROMIUM_PATH does not point to an available executable");
    }
    return process.env.YAVER_CHROMIUM_PATH;
  }

  const candidates = [
    chromium.executablePath(),
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
  for (const candidate of candidates) {
    if (await executable(candidate)) return candidate;
  }
  throw new Error("no Chromium executable is available; install Playwright Chromium or set YAVER_CHROMIUM_PATH");
}

function redact(value) {
  return String(value)
    .replaceAll(os.homedir(), "[home]")
    .replace(/([?&](?:token|key|password)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .slice(0, 500);
}

async function queuedCases() {
  const cases = [];
  const dates = (await fs.readdir(queueRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const dateEntry of dates) {
    const names = (await fs.readdir(path.join(queueRoot, dateEntry.name)))
      .filter((name) => name.endsWith(".md"))
      .sort();
    for (const name of names) {
      const relative = path.join("test-cases", dateEntry.name, name);
      const body = await fs.readFile(path.join(root, relative), "utf8");
      if (/^- Status:\s*`queued`\s*$/m.test(body)) cases.push(relative);
    }
  }
  return cases;
}

async function lockSession() {
  try {
    return await fs.open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const raw = await fs.readFile(lockPath, "utf8").catch(() => "");
    const pid = Number(raw.trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        throw new Error(`another browser coordinator is active (pid ${pid})`);
      } catch (probeError) {
        if (probeError.code !== "ESRCH") throw probeError;
      }
    }
    await fs.unlink(lockPath);
    return fs.open(lockPath, "wx", 0o600);
  }
}

if (!target) {
  console.error("MOBILE_WEB_URL is required; refusing to substitute a dashboard or guessed port.");
  process.exit(2);
}
const parsedTarget = new URL(target);
if (!/^https?:$/.test(parsedTarget.protocol)) {
  console.error("MOBILE_WEB_URL must use HTTP or HTTPS.");
  process.exit(2);
}

const cases = await queuedCases();
if (!cases.length) {
  console.error("No queued browser cases. Add a dated Markdown case and validate it first.");
  process.exit(2);
}

let lock;
try {
  lock = await lockSession();
} catch (error) {
  console.error(redact(error?.message || error));
  process.exit(1);
}
await lock.writeFile(`${process.pid}\n`);
let context;
let closing = false;
async function close(exitCode = 0) {
  if (closing) return;
  closing = true;
  await context?.close().catch(() => {});
  await lock.close().catch(() => {});
  await fs.unlink(lockPath).catch(() => {});
  process.exit(exitCode);
}
process.once("SIGINT", () => void close(0));
process.once("SIGTERM", () => void close(0));

try {
  const browserExecutable = await resolveChromiumExecutable();
  context = await chromium.launchPersistentContext(profile, {
    ...iphone,
    headless: false,
    executablePath: browserExecutable,
  });
  const page = context.pages()[0] || await context.newPage();
  const viewport = page.viewportSize();
  if (!viewport || viewport.width !== iphone.viewport.width || viewport.height !== iphone.viewport.height) {
    throw new Error(`device context mismatch: expected ${iphone.viewport.width}x${iphone.viewport.height}, got ${viewport?.width ?? "none"}x${viewport?.height ?? "none"}`);
  }
  page.on("console", (message) => {
    if (message.type() === "error") console.error(`[app error] ${redact(message.text())}`);
  });
  page.on("pageerror", (error) => console.error(`[page error] ${redact(error.message)}`));

  console.log(`queued cases (${cases.length}):`);
  for (const item of cases) console.log(`- ${item}`);
  console.log(`device context: iPhone 15 Pro ${viewport.width}x${viewport.height}, touch=${iphone.hasTouch}`);
  console.log(`profile: browser-automation-${date}${process.env.E2E_PROFILE ? " (override)" : " (isolated)"}`);
  console.log("opening configured RN-web target (URL hidden to avoid leaking infrastructure)");
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 180_000 });
  console.log("browser coordinator session is open; write each attempt to the dated results directory");
  await new Promise(() => {});
} catch (error) {
  console.error(redact(error?.stack || error));
  await close(1);
}
