#!/usr/bin/env node
/**
 * Render one real remote project through Chrome at every canonical Yaver
 * surface profile. This is the cheap, automation-friendly lane: it proves the
 * agent, relay, dev server, RN-web bundle and painted pixels without claiming
 * that Chrome is a native tvOS/watchOS/visionOS runtime.
 *
 *   npx tsx e2e/lightweight-surface-render.mjs
 *
 * Optional environment:
 *   VIBE_BOX                 device name/substring (default ubuntu-4gb-hel1-1)
 *   VIBE_DEVICE_ID           exact device id; bypasses name lookup
 *   VIBE_PROJECT_NAME        discovered project name (default sfmg)
 *   VIBE_PROJECT_PATH        exact remote path; otherwise /projects resolves it
 *   VIBE_SURFACES            CSV from web,mobile,tablet,tv,vision,watch
 *   VIBE_ARTIFACT_DIR        output directory
 *   VIBE_KEEP_DEV_SERVER=1   leave the remote preview running
 *
 * Credentials come from ~/.yaver/config.json. They are never put in a URL,
 * artifact or browser-wide header: request interception adds them only to the
 * selected owned relay-device prefix.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, devices } from "@playwright/test";
import {
  classifyVibeColor,
  looksRendered,
  modalColor,
  samplePoints,
} from "../web/lib/vibeVerdict.ts";
import {
  SURFACE_PROFILES,
  profileFor,
  viewportMatchesSurface,
} from "../web/lib/surfaceViewports.ts";
import { decodePng, samplePixels } from "./_framePixels.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timestamp = () => new Date().toISOString();
const runID = (process.env.LOOP_RUN_ID || timestamp()).replace(/[:.]/g, "-");
const artifacts = path.resolve(
  process.env.VIBE_ARTIFACT_DIR ||
    path.join("e2e", "test-results", "lightweight-surfaces", runID),
);
const wantedDevice = process.env.VIBE_BOX || "ubuntu-4gb-hel1-1";
const wantedProject = process.env.VIBE_PROJECT_NAME || "sfmg";
const keepDevServer = process.env.VIBE_KEEP_DEV_SERVER === "1";

function localBrowserExecutable() {
  const explicit = String(
    process.env.YAVER_CHROMIUM_PATH || process.env.YAVER_CHROME_PATH || "",
  ).trim();
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(`NAMED: configured browser executable does not exist: ${explicit}`);
    }
    return explicit;
  }
  // Playwright's duplicated browser bundle is intentionally reclaimable on a
  // developer machine. Reuse an installed system browser when present; CI has
  // neither path and therefore keeps Playwright's managed-browser behavior.
  const candidates = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ]
    : process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

const requestedSurfaces = (process.env.VIBE_SURFACES || Object.keys(SURFACE_PROFILES).join(","))
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
for (const surface of requestedSurfaces) {
  if (!(surface in SURFACE_PROFILES)) {
    throw new Error(`unknown surface ${JSON.stringify(surface)}; use ${Object.keys(SURFACE_PROFILES).join(",")}`);
  }
}

const configPath = path.join(os.homedir(), ".yaver", "config.json");
if (!fs.existsSync(configPath)) {
  throw new Error(`NAMED: ${configPath} is missing; sign in to Yaver before running the live surface loop`);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const token = String(process.env.YAVER_TEST_TOKEN || config.auth_token || "").trim();
const relayPassword = String(config.cached_relay_password || config.relay_password || "").trim();
const convex = String(
  process.env.YAVER_CONVEX_SITE ||
    config.convex_site_url ||
    "https://perceptive-minnow-557.eu-west-1.convex.site",
).replace(/\/$/, "");
const relay = String(process.env.YAVER_RELAY_HTTP || "https://public.yaver.io").replace(/\/$/, "");
if (!token || !relayPassword) {
  throw new Error("NAMED: Yaver auth token or relay password is missing from the local signed-in configuration");
}

function redact(value) {
  return String(value || "")
    .split(token).join("<token>")
    .split(relayPassword).join("<relay-password>")
    .replace(/([?&](?:token|__rp)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,}]+/gi, "$1<redacted>");
}

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { response, body, text };
}

async function resolveDeviceID() {
  if (process.env.VIBE_DEVICE_ID) return process.env.VIBE_DEVICE_ID.trim();
  const { response, body, text } = await jsonFetch(`${convex}/devices/list`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`NAMED: device inventory returned HTTP ${response.status}: ${redact(text).slice(0, 300)}`);
  }
  const rows = Array.isArray(body) ? body : body?.devices || body?.data || [];
  const needle = wantedDevice.toLowerCase();
  const matches = rows.filter((row) =>
    String(row.name || row.hostname || "").toLowerCase().includes(needle));
  if (matches.length !== 1) {
    throw new Error(
      `NAMED: ${JSON.stringify(wantedDevice)} matched ${matches.length} owned devices; ` +
      "set VIBE_DEVICE_ID to one exact owned device",
    );
  }
  return String(matches[0].deviceId || matches[0].id || matches[0]._id || "");
}

const deviceID = await resolveDeviceID();
if (!deviceID) throw new Error("NAMED: resolved device has no device id");
const baseURL = `${relay}/d/${deviceID}`;
const agentHeaders = {
  Authorization: `Bearer ${token}`,
  "X-Relay-Password": relayPassword,
  "Content-Type": "application/json",
};

async function agent(pathname, init = {}) {
  const { response, body, text } = await jsonFetch(`${baseURL}${pathname}`, {
    ...init,
    headers: { ...agentHeaders, ...(init.headers || {}) },
  });
  return { status: response.status, ok: response.ok, body, text };
}

async function resolveProjectPath() {
  const explicit = String(process.env.VIBE_PROJECT_PATH || "").trim();
  if (explicit) return explicit;
  const listed = await agent("/projects");
  if (!listed.ok) {
    throw new Error(`NAMED: /projects returned HTTP ${listed.status}: ${redact(listed.text).slice(0, 300)}`);
  }
  const rows = Array.isArray(listed.body) ? listed.body : listed.body?.projects || [];
  const exact = rows.filter((row) => String(row.name || "").toLowerCase() === wantedProject.toLowerCase());
  if (exact.length !== 1 || !exact[0].path) {
    throw new Error(
      `NAMED: project ${JSON.stringify(wantedProject)} resolved to ${exact.length} rows with a usable path`,
    );
  }
  return String(exact[0].path);
}

const projectPath = await resolveProjectPath();

async function startPreview() {
  const started = await agent("/dev/start", {
    method: "POST",
    body: JSON.stringify({
      framework: "expo",
      workDir: projectPath,
      platform: "web",
      caller: "e2e-lightweight-surface",
    }),
  });
  if (!started.ok) {
    throw new Error(`NAMED: /dev/start returned HTTP ${started.status}: ${redact(started.text).slice(0, 500)}`);
  }

  const deadline = Date.now() + Number(process.env.VIBE_BOOT_BUDGET_MS || 5 * 60_000);
  let lastReason = "no status yet";
  while (Date.now() < deadline) {
    const status = await agent("/dev/status");
    const row = status.body || {};
    const previewPath =
      (typeof row.bundleUrl === "string" && row.bundleUrl) ||
      (Number(row.webPort) > 0 ? "/dev-web/" : "");
    lastReason = row.error || row.message || `webPort=${row.webPort || 0}, bundleUrl=${row.bundleUrl || ""}`;
    if (previewPath) {
      const probe = await agent(previewPath);
      if (probe.status === 200) {
        // An Expo HTML shell can answer 200 several seconds before its entry
        // bundle is usable. Opening Chrome at that point produced a real
        // `entry.bundle ... ERR_CONNECTION_RESET`, followed by an empty root
        // even though /dev/status stayed green. Extract and fetch the exact
        // script the shell references; that is the operation the browser
        // needs, not the webPort inventory proxy.
        const encodedSrc = probe.text.match(
          /(?:src|href)=["']([^"']*entry\.bundle[^"']*)["']/i,
        )?.[1];
        if (!encodedSrc) return previewPath;
        const src = encodedSrc.replaceAll("&amp;", "&");
        const url = new URL(src, `https://yaver.invalid${previewPath}`);
        const bundlePath = `${url.pathname}${url.search}`;
        try {
          const bundle = await agent(bundlePath, {
            signal: AbortSignal.timeout(Math.min(120_000, Math.max(1_000, deadline - Date.now()))),
          });
          if (bundle.status === 200 && bundle.text.length > 1_000 && !/^\s*</.test(bundle.text)) {
            console.log(`preview bundle warm ${bundle.text.length} bytes`);
            return previewPath;
          }
          lastReason = `${bundlePath} returned HTTP ${bundle.status} or an HTML fallback`;
        } catch (error) {
          lastReason = `${bundlePath} probe failed: ${redact(error?.message || error)}`;
        }
      } else {
        lastReason = `${previewPath} returned HTTP ${probe.status}`;
      }
    }
    await sleep(3_000);
  }
  throw new Error(`NAMED: SFMG preview did not become reachable: ${redact(lastReason)}`);
}

function browserOptionsFor(surface) {
  const profile = profileFor(surface);
  if (profile.playwrightDevice) {
    const descriptor = devices[profile.playwrightDevice];
    if (!descriptor) throw new Error(`Playwright has no device descriptor ${profile.playwrightDevice}`);
    return {
      ...descriptor,
      // The descriptor supplies UA/touch/mobile behavior. The shared Yaver
      // table remains authoritative for geometry; Desktop Chrome's Playwright
      // default is 1280x720, while the real dashboard contract is 1600x1100.
      viewport: { width: profile.width, height: profile.height },
      deviceScaleFactor: profile.deviceScaleFactor,
    };
  }
  const behavioralDescriptor = profile.isMobile
    ? devices["iPhone 15"]
    : devices["Desktop Chrome"];
  return {
    ...behavioralDescriptor,
    viewport: { width: profile.width, height: profile.height },
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
  };
}

async function renderSurface(browserExecutable, surface, previewPath) {
  const profile = profileFor(surface);
  let browser = null;
  let context = null;
  let page = null;
  const events = [];
  const record = (event) => events.push({ at: timestamp(), ...event });

  let result;
  try {
    browser = await chromium.launch(browserExecutable ? { executablePath: browserExecutable } : {});
    context = await browser.newContext(browserOptionsFor(surface));
    page = await context.newPage();
    page.on("console", (message) => record({
      type: "console",
      level: message.type(),
      text: redact(message.text()).slice(0, 2_000),
    }));
    page.on("pageerror", (error) => record({
      type: "pageerror",
      text: redact(error.message).slice(0, 2_000),
    }));
    page.on("requestfailed", (request) => record({
      type: "requestfailed",
      url: redact(request.url()),
      error: request.failure()?.errorText || "request failed",
    }));

    // Scope credentials to the one owned relay-device prefix. Context-wide
    // headers would also attach the bearer token to third-party assets.
    await page.route(`${baseURL}/**`, async (route) => {
      await route.continue({
        headers: { ...route.request().headers(), ...agentHeaders },
      });
    });

    const domBudget = Number(process.env.VIBE_DOM_BUDGET_MS || 45_000);
    const mountDeadline = Date.now() + domBudget;
    let response = null;
    let mountError = null;
    // A relay connection can reset independently of Metro readiness. Retry
    // the real page navigation while the one shared mount budget remains;
    // never sit on an HTML shell whose first bundle request already failed.
    for (let attempt = 1; attempt <= 3 && Date.now() < mountDeadline; attempt++) {
      try {
        response = await page.goto(`${baseURL}${previewPath}`, {
          waitUntil: "domcontentloaded",
          timeout: Math.min(120_000, Math.max(1_000, mountDeadline - Date.now())),
        });
        await page.waitForFunction(
          () => (document.getElementById("root")?.children.length || 0) > 0,
          null,
          { timeout: Math.max(1_000, mountDeadline - Date.now()) },
        );
        mountError = null;
        break;
      } catch (error) {
        mountError = error;
        record({ type: "mount_retry", attempt, error: redact(error?.message || error) });
        if (attempt < 3 && Date.now() < mountDeadline) await sleep(1_000);
      }
    }
    if (mountError) throw mountError;
    await page.waitForTimeout(4_000);
    const observed = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      isMobile: /Mobile|iPhone|iPad|Android/i.test(navigator.userAgent),
      hasTouch: navigator.maxTouchPoints > 0,
      rootChildren: document.getElementById("root")?.children.length || 0,
      bodyText: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 600),
    }));
    const profileMatch = viewportMatchesSurface(surface, observed);
    const screenshotPath = path.join(artifacts, `${surface}.png`);
    const png = await page.screenshot({ path: screenshotPath, fullPage: false });
    const image = decodePng(png);
    const samples = samplePixels(image, samplePoints, Math.max(4, Math.floor(image.width / 180)));
    const modal = modalColor(samples);
    const painted = looksRendered(samples);
    const eventCounts = Object.fromEntries(
      [...new Set(events.map((event) => event.type))]
        .map((type) => [type, events.filter((event) => event.type === type).length]),
    );
    result = {
      surface,
      verdict: observed.rootChildren > 0 && painted && profileMatch.ok ? "PIXELS" : "SILENT",
      fidelity: ["tv", "vision", "watch"].includes(surface)
        ? "SURROGATE_PIXELS"
        : "BROWSER_PIXELS",
      httpStatus: response?.status() || 0,
      profile: {
        width: profile.width,
        height: profile.height,
        deviceScaleFactor: profile.deviceScaleFactor,
        isMobile: profile.isMobile,
        hasTouch: profile.hasTouch,
      },
      observed,
      profileMatch,
      painted,
      modalRGB: modal,
      modalClass: classifyVibeColor(modal),
      distinctSampleColors: new Set(samples.map((sample) => sample.join(","))).size,
      screenshot: screenshotPath,
      eventCounts,
    };
  } catch (error) {
    result = {
      surface,
      verdict: "SILENT",
      fidelity: ["tv", "vision", "watch"].includes(surface)
        ? "SURROGATE_PIXELS"
        : "BROWSER_PIXELS",
      error: redact(error?.message || error),
    };
  } finally {
    fs.writeFileSync(
      path.join(artifacts, `${surface}.events.jsonl`),
      events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""),
    );
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
  return result;
}

fs.mkdirSync(artifacts, { recursive: true });
const previewPath = await startPreview();
const browserExecutable = localBrowserExecutable();
const results = [];
const startedAt = timestamp();
const writeManifest = (complete) => fs.writeFileSync(
  path.join(artifacts, complete ? "manifest.json" : "manifest.partial.json"),
  JSON.stringify({
    runID,
    startedAt,
    completedAt: complete ? timestamp() : null,
    complete,
    device: wantedDevice,
    deviceID,
    project: wantedProject,
    projectPath,
    previewPath,
    evidence: "Chrome browser pixels; tv/vision/watch are explicitly surrogate, never native verdicts",
    results,
  }, null, 2),
);
try {
  for (const surface of requestedSurfaces) {
    const result = await renderSurface(browserExecutable, surface, previewPath);
    results.push(result);
    writeManifest(false);
    console.log(
      `${result.verdict.padEnd(6)} ${surface.padEnd(7)} ${result.fidelity}` +
      (result.modalRGB ? ` rgb(${result.modalRGB.join(",")})` : "") +
      (result.error ? ` — ${result.error}` : ""),
    );
    if (result.verdict !== "PIXELS" && process.env.VIBE_FAIL_FAST === "1") break;
  }
} finally {
  if (!keepDevServer) {
    await agent("/dev/stop", { method: "POST", body: "{}" }).catch(() => null);
  }
}

writeManifest(true);
fs.rmSync(path.join(artifacts, "manifest.partial.json"), { force: true });
console.log(`artifacts ${artifacts}`);
if (results.some((result) => result.verdict !== "PIXELS")) process.exitCode = 1;
