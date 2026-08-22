import { chromium, devices } from "playwright";

const appURL = (process.env.MOBILE_WEB_URL || "").replace(/\/$/, "");
const token = process.env.YAVER_TEST_TOKEN || "";
const requireWorkspaceReady = process.env.REQUIRE_WORKSPACE_READY === "1";
if (!appURL || !token) {
  throw new Error("MOBILE_WEB_URL and YAVER_TEST_TOKEN are required");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeErrorClasses(messages) {
  const text = messages.join("\n").toLowerCase();
  return {
    count: messages.length,
    auth: /401|403|auth|token|sign.?in/.test(text),
    cors: /cors|cross-origin/.test(text),
    network: /fetch|network|connect|transport|timeout/.test(text),
  };
}

const iphone = devices["iPhone 15 Pro"];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext(iphone);
await context.addInitScript((authToken) => {
  // A fresh browser context otherwise executes the native reinstall guard and
  // intentionally clears the token before AuthContext can validate it.
  localStorage.setItem("yaver_installed", "1");
  localStorage.setItem("yaver.secure.yaver_auth_token", authToken);
}, token);
const page = await context.newPage();
const errors = [];
const probes = { auth: null, devices: null, settings: null, storage: null, requestFailures: {}, failedPaths: [], failedResponses: [] };
page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
page.on("response", async (response) => {
  const pathname = new URL(response.url()).pathname;
  if (response.status() >= 400 && probes.failedResponses.length < 8) {
    probes.failedResponses.push({ path: pathname, status: response.status() });
  }
  if (pathname.endsWith("/auth/validate")) {
    probes.auth = { status: response.status() };
  } else if (pathname.endsWith("/devices/list")) {
    const body = await response.json().catch(() => ({}));
    probes.devices = {
      status: response.status(),
      count: Array.isArray(body.devices) ? body.devices.length : Array.isArray(body) ? body.length : null,
    };
  } else if (pathname.endsWith("/settings")) {
    const body = await response.json().catch(() => ({}));
    probes.settings = {
      status: response.status(),
      primaryConfigured: Boolean(body.primaryDeviceId ?? body.settings?.primaryDeviceId),
    };
  }
});
page.on("requestfailed", (request) => {
  const pathname = new URL(request.url()).pathname;
  const kind = pathname.endsWith("/api/mobile-config") ? "config"
    : pathname.endsWith("/auth/validate") ? "auth"
      : pathname.endsWith("/devices/list") ? "devices"
        : "other";
  probes.requestFailures[kind] = (probes.requestFailures[kind] || 0) + 1;
  if (probes.failedPaths.length < 5) probes.failedPaths.push(pathname);
});

try {
  await page.goto(`${appURL}/phone-projects`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.getByText("Mobile Workspace", { exact: true }).waitFor({ timeout: 60_000 });
  probes.storage = await page.evaluate(() => ({
    installed: localStorage.getItem("yaver_installed") === "1",
    tokenPresent: Boolean(localStorage.getItem("yaver.secure.yaver_auth_token")),
  }));
  const viewport = page.viewportSize();
  const device = await page.evaluate(() => ({
    dpr: window.devicePixelRatio,
    touch: navigator.maxTouchPoints,
    ua: navigator.userAgent,
  }));
  assert(viewport?.width === iphone.viewport.width && viewport?.height === iphone.viewport.height, "not using the iPhone device viewport");
  assert(device.touch > 0 && /Mobile|iPhone/i.test(device.ua) && device.dpr >= 2, "not using a genuine mobile/touch context");

  await page.getByText("+ New mobile app", { exact: true }).click();
  await page.getByPlaceholder("My app").fill("Remote Todo Validation");
  await page.getByText("Next", { exact: true }).click();

  await page.getByText("2. Development target", { exact: true }).waitFor();
  let primaryHydrated = true;
  try {
    await page.getByText("Primary device · Recommended", { exact: true }).waitFor({ timeout: 60_000 });
  } catch {
    primaryHydrated = false;
  }
  const placement = await page.locator("body").innerText().then((text) => ({
    primary: text.includes("Primary device · Recommended"),
    connected: text.includes("Connected machine"),
    other: text.includes("Other online box"),
    missing: text.includes("Connect a Yaver machine first"),
  }));
  assert(
    primaryHydrated && placement.primary,
    `primary recommendation missing: ${JSON.stringify(placement)} probes=${JSON.stringify(probes)} errors=${JSON.stringify(safeErrorClasses(errors))}`,
  );
  const readyState = page.getByText("Ready", { exact: true }).first();
  const upgradeState = page.getByText("Agent update required", { exact: true });
  const unreachableState = page.getByText("Couldn't audit this remote box", { exact: true });
  try {
    await page.waitForFunction(() => {
      const text = document.body.innerText;
      return text.includes("Agent update required") || text.includes("Couldn't audit this remote box") || /(^|\n)Ready($|\n)/.test(text);
    }, undefined, { timeout: 60_000 });
  } catch {
    const state = await page.locator("body").innerText().then((text) => ({
      targetStep: text.includes("2. Development target"),
      runnerSection: text.includes("Runner"),
      notConfigured: text.includes("Not configured"),
      notInstalled: text.includes("Not installed"),
      checking: text.includes("Testing runner…"),
      connectMachine: text.includes("Connect a Yaver machine first"),
    }));
    throw new Error(`workspace readiness did not settle: ${JSON.stringify(state)} probes=${JSON.stringify(probes)} errors=${JSON.stringify(safeErrorClasses(errors))}`);
  }
  const targetText = await page.locator("body").innerText();
  assert(!/remoteless/i.test(targetText), "Mobile Workspace must not offer Remoteless placement");
  assert(/Yaver Serverless/i.test(targetText), "fixed Yaver Serverless stack is not visible");

  if (await unreachableState.isVisible()) {
    assert(await page.getByText("Retry readiness check →", { exact: true }).count() === 1, "unreachable readiness has no retry action");
    assert(!targetText.includes("Not configured"), "an unreachable agent was misreported as an unconfigured runner");
    assert(!requireWorkspaceReady, "Mobile Workspace readiness is required, but the selected box could not be audited");
    console.log("live Mobile Workspace unreachable-agent recovery route passed");
  } else if (await upgradeState.isVisible()) {
    assert(await page.getByText("Update Yaver agent →", { exact: true }).count() === 1, "agent upgrade has no in-place action");
    assert(!targetText.includes("Not configured"), "an old agent was misreported as an unconfigured runner");
    assert(!requireWorkspaceReady, "Mobile Workspace readiness is required, but the selected box still runs an older agent");
    console.log("live Mobile Workspace old-agent recovery route passed");
  } else {
    await page.getByText(/OpenCode · (Preferred|Recommended)/).waitFor({ timeout: 30_000 });
    await page.getByText("deepseek/deepseek-v4-flash", { exact: true }).waitFor({ timeout: 30_000 });

    // Next runs the real remote provider probe before persisting the selected
    // device, runner, model, mode, and provider as the task defaults.
    await page.getByText("Next", { exact: true }).click();
    await page.getByText("3. Git provider", { exact: true }).waitFor({ timeout: 90_000 });
    await page.getByText("Yaver Git · Ready", { exact: true }).waitFor();
    await page.getByText("Mirror now", { exact: true }).click();
    await page.getByText(/GitHub · (Connected|Clone ready)/).waitFor({ timeout: 30_000 });
    await page.getByText(/GitLab · (Connected|Clone ready)/).waitFor({ timeout: 30_000 });
    assert(await page.getByText(/GitHub · (Connected|Clone ready)/).count() === 1, "GitHub status is ambiguous");
    assert(await page.getByText(/GitLab · (Connected|Clone ready)/).count() === 1, "GitLab status is ambiguous");
    console.log("live Mobile Workspace onboarding passed");
  }

  assert(errors.length === 0, `Mobile Workspace browser errors: classes=${JSON.stringify(safeErrorClasses(errors))} probes=${JSON.stringify(probes)}`);
} finally {
  await context.close();
  await browser.close();
}
