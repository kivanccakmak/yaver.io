// Live RN-web machine × runner audit. Machine names are supplied at runtime so
// the public repository never captures an owner's private device inventory.
import { chromium, devices } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const appURL = process.env.MOBILE_WEB_URL || "http://localhost:8081";
const linuxName = process.env.E2E_MATRIX_LINUX;
const desktopName = process.env.E2E_MATRIX_DESKTOP;
const matrixOnly = process.env.E2E_MATRIX_ONLY || "";
if (!linuxName || !desktopName) throw new Error("Set E2E_MATRIX_LINUX and E2E_MATRIX_DESKTOP");

const artifacts = join(process.cwd(), "test-results", "mobile-machine-runner-live");
await mkdir(artifacts, { recursive: true });
const config = JSON.parse(await readFile(join(homedir(), ".yaver", "config.json"), "utf8"));
const token = config.auth_token;
const convex = config.convex_site_url;
const relay = config.cached_relay_servers?.[0];
const relayPassword = config.cached_relay_password || config.relay_password || relay?.password || "";
const relayURL = relay?.http_url || "";
if (!token || !convex) throw new Error("Signed-in Yaver config is required");

const executablePath = [
  process.env.YAVER_CHROMIUM_PATH,
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((candidate) => candidate && existsSync(candidate));
const profile = process.env.E2E_PROFILE;
const browser = profile
  ? null
  : await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const context = profile
  ? await chromium.launchPersistentContext(profile, {
      ...devices["iPhone 15 Pro"], headless: true, ...(executablePath ? { executablePath } : {}),
    })
  : await browser.newContext({ ...devices["iPhone 15 Pro"] });
const page = context.pages()[0] || await context.newPage();
const results = [];
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
});
page.on("pageerror", (error) => consoleErrors.push(error.message.slice(0, 300)));
page.on("response", (response) => {
  if (response.status() >= 400) {
    const url = new URL(response.url());
    failedResponses.push(`${response.status()} ${url.origin}${url.pathname}`);
  }
});

function safeSlug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}

async function visible(locator) {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) return locator.nth(index);
  }
  return null;
}

async function visibleText(pattern) {
  return visible(page.getByText(pattern));
}

async function clickVisibleText(pattern) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const match = await visibleText(pattern);
    if (match) { await match.click(); return; }
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(200);
  }
  throw new Error(`No visible text matching ${pattern}`);
}

async function clickPressableWithText(text) {
  return page.evaluate((needle) => {
    const rows = Array.from(document.querySelectorAll('[tabindex="0"]'));
    const target = rows.find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && (element.textContent || "").trim() === needle;
    });
    if (!target) return false;
    target.click();
    return true;
  }, text);
}

async function seedSession() {
  console.log("[audit] mounting RN-web and restoring the signed-in device session");
  await page.goto(appURL, { waitUntil: "domcontentloaded", timeout: 180_000 });
  const response = await page.request.get(`${convex}/auth/validate?_=${Date.now()}`, {
    headers: { Authorization: `Bearer ${token}`, "Cache-Control": "no-store" },
  });
  if (!response.ok()) throw new Error(`Session validation failed: HTTP ${response.status()}`);
  const payload = await response.json();
  const row = payload.user || {};
  const user = {
    id: row.userId, email: row.email, name: row.fullName, provider: row.provider,
    emailVerified: row.emailVerified, surveyCompleted: row.surveyCompleted, isOwner: row.isOwner,
  };
  await page.evaluate(({ authToken, userRow, localRelayPassword, localRelayURL }) => {
    localStorage.setItem("yaver_installed", "1");
    localStorage.setItem("yaver.secure.yaver_auth_token", authToken);
    localStorage.setItem("yaver.secure.yaver_user", JSON.stringify(userRow));
    if (localRelayPassword) localStorage.setItem("yaver.secure.yaver_key_relay_password", localRelayPassword);
    if (localRelayURL) localStorage.setItem("yaver.secure.yaver_key_relay_url", localRelayURL);
  }, { authToken: token, userRow: user, localRelayPassword: relayPassword, localRelayURL: relayURL });
  // The first anonymous mount redirects the URL itself to /login. Reloading
  // would faithfully keep that route even after storage is authenticated;
  // return through the root router so AuthContext can choose Tasks.
  await page.goto(appURL, { waitUntil: "domcontentloaded", timeout: 180_000 });
  if (matrixOnly === "vibing") {
    await page.goto(`${appURL.replace(/\/$/, "")}/more`, { waitUntil: "domcontentloaded", timeout: 180_000 });
    for (let attempt = 0; attempt < 90 && !(await visibleText(/^More$/)); attempt += 1) await page.waitForTimeout(1000);
    if (!(await visibleText(/^More$/))) throw new Error("Authenticated mobile shell did not expose More");
    const viewport = page.viewportSize();
    results.push({ check: "device-context", verdict: "PIXELS", detail: `${viewport.width}x${viewport.height}, mobile+touch` });
    return;
  }
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (attempt >= 10 && attempt % 5 === 0) {
      const chooseManually = await visibleText(/^Choose a machine myself$/i);
      if (chooseManually) {
        await clickPressableWithText("Choose a machine myself");
      }
    }
    const shellReady = await visibleText(/^(Switch|Pick)/i) || await visibleText(/^Remote Box$/i);
    if (shellReady) break;
    await page.waitForTimeout(1000);
  }
  await page.screenshot({ path: join(artifacts, "authenticated-shell.png"), fullPage: true });
  if (!(await visibleText(/^(Switch|Pick)/i)) && !(await visibleText(/^Remote Box$/i))) {
    const body = ((await page.locator("body").innerText().catch(() => "")) || "").replace(/\s+/g, " ").slice(0, 1200);
    const storage = await page.evaluate(() => ({
      keys: Object.keys(localStorage).filter((key) => key.startsWith("yaver")),
      hasToken: !!localStorage.getItem("yaver.secure.yaver_auth_token"),
      hasUser: !!localStorage.getItem("yaver.secure.yaver_user"),
    }));
    throw new Error(`Authenticated mobile shell did not expose Tasks. Storage: ${JSON.stringify(storage)}. Failed responses: ${JSON.stringify(failedResponses.slice(-12))}. Visible text: ${body}`);
  }
  const viewport = page.viewportSize();
  if (viewport?.width !== 393 || !devices["iPhone 15 Pro"].isMobile || !devices["iPhone 15 Pro"].hasTouch) {
    throw new Error(`Wrong device context: ${JSON.stringify(viewport)}`);
  }
  results.push({ check: "device-context", verdict: "PIXELS", detail: `${viewport.width}x${viewport.height}, mobile+touch` });
}

async function selectMachine(name) {
  console.log(`[audit] selecting machine ${safeSlug(name)}`);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const target = new RegExp(escaped, "i");
  const runnerButton = await visible(page.locator('button[aria-label^="Change coding agent on "]'));
  if (runnerButton && target.test((await runnerButton.getAttribute("aria-label")) || "")) return;

  if (await visibleText(/^Pick a machine$/i)) {
    const inlineText = await visible(page.getByText(target));
    if (!inlineText) throw new Error(`Machine is absent from inline picker: ${name}`);
    await inlineText.locator("xpath=ancestor::div[@tabindex='0'][1]").evaluate((element) => element.click());
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const connectedRunner = await visible(page.locator('button[aria-label^="Change coding agent on "]'));
      if (connectedRunner && target.test((await connectedRunner.getAttribute("aria-label")) || "")) return;
      await page.waitForTimeout(1000);
    }
    throw new Error(`Inline picker did not connect ${name}`);
  }

  if (!(await visibleText(/^Remote Box$/i))) {
    const switchButton = await visibleText(/^(Switch|Pick)/i);
    if (!switchButton) throw new Error("Tasks does not expose the Remote Box switcher");
    await switchButton.click();
    await page.getByText(/^Remote Box$/i).waitFor({ state: "visible", timeout: 30_000 });
  }
  const machineText = await visible(page.getByText(target));
  if (!machineText) throw new Error(`Machine is absent from Remote Box picker: ${name}`);
  // RN-web's Text node is repeatedly replaced while runner probes land. Click
  // the stable Pressable ancestor, which is also the user's actual tap target.
  const machineRow = machineText.locator("xpath=ancestor::div[@tabindex='0'][1]");
  await machineRow.evaluate((element) => element.click());
  await clickVisibleText(/^(Use selected machine|Keep using this machine|Reconnect to this machine|Connect to this machine)$/i);
  let label = "";
  let switchRetries = 0;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const switchFailure = await visibleText(/^Couldn't switch$/i);
    if (switchFailure) {
      if (switchRetries < 2 && await clickPressableWithText("Try again")) {
        switchRetries += 1;
        await page.waitForTimeout(750);
        continue;
      }
      const body = ((await page.locator("body").innerText()) || "").replace(/\s+/g, " ");
      const at = body.indexOf("Couldn't switch");
      throw new Error(`Remote Box switch failed: ${body.slice(at, at + 500)}`);
    }
    const updated = await visible(page.locator('button[aria-label^="Change coding agent on "]'));
    label = (await updated?.getAttribute("aria-label")) || "";
    // "Connected" also exists in the Tasks banner behind the sheet, so only
    // the modal's transient Switching title can gate this hand-off.
    const switching = await visibleText(/^Switching$/i);
    if (!switching && target.test(label)) { await page.waitForTimeout(600); return; }
    await page.waitForTimeout(1000);
  }
  throw new Error(`Visible box and runner target diverged: ${label}`);
}

async function selectRunner(machine, runner) {
  console.log(`[audit] selecting ${runner} on ${safeSlug(machine)}`);
  const button = await visible(page.locator('button[aria-label^="Change coding agent on "]'));
  if (!button) throw new Error("Tasks overview has no coding-agent control");
  await button.evaluate((element) => element.click());
  const choice = await visible(page.getByRole("button", { name: new RegExp(`^Use ${runner} on `, "i") }));
  if (!choice) throw new Error(`${runner} is not selectable from Tasks overview`);
  await choice.evaluate((element) => element.click());
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(artifacts, `${safeSlug(machine)}-${safeSlug(runner)}-selected.png`), fullPage: true });
}

async function runHello(machine, runner, ordinal) {
  await selectMachine(machine);
  await selectRunner(machine, runner);
  const marker = `YAVER_BROWSER_HELLO_${ordinal}`;
  console.log(`[audit] dispatching ${marker}`);
  const newTask = await visible(page.locator('[aria-label="Dictate a new task"], [aria-label="New task"]'));
  if (!newTask) throw new Error("Tasks has no new-task action");
  await newTask.click();
  await page.getByText(/^New task$/).waitFor({ state: "visible", timeout: 30_000 });
  const input = page.getByRole("textbox").last();
  await input.fill(`Reply with exactly ${marker}. Do not modify files and do not run commands.`);
  const sendText = await visibleText(/^Send$/);
  if (!sendText) throw new Error("New-task composer has no enabled Send action");
  await sendText.locator("xpath=ancestor::div[@tabindex='0'][1]").evaluate((element) => element.click());
  await page.locator('[aria-label="Back to tasks list"]').waitFor({ state: "visible", timeout: 90_000 });
  const runnerChip = page.locator('[aria-label^="Change coding agent for the next turn"]');
  const expectedRunner = new RegExp(runner, "i");
  await runnerChip.filter({ hasText: expectedRunner }).first().waitFor({ state: "visible", timeout: 90_000 });
  await page.getByText(new RegExp(machine.replace(/\.local$/i, ""), "i")).first().waitFor({ state: "visible", timeout: 90_000 });
  let completed = false;
  for (let attempt = 0; attempt < 360; attempt += 1) {
    const body = (await page.locator("body").innerText().catch(() => "")) || "";
    const markerCount = body.split(marker).length - 1;
    if (/\b(COMPLETED|REVIEW)\b/.test(body) && markerCount >= 2) { completed = true; break; }
    if (/\bFAILED\b/.test(body)) {
      await page.screenshot({ path: join(artifacts, `${safeSlug(machine)}-${safeSlug(runner)}-failed.png`), fullPage: true });
      const failureAt = body.indexOf("FAILED");
      const excerpt = body.slice(Math.max(0, failureAt - 300), failureAt + 1400).replace(/\s+/g, " ");
      throw new Error(`${marker} task failed: ${excerpt}`);
    }
    await page.waitForTimeout(1000);
  }
  if (!completed) throw new Error(`${marker} never produced a completed visible response`);
  await page.screenshot({ path: join(artifacts, `${safeSlug(machine)}-${safeSlug(runner)}-result.png`), fullPage: true });
  results.push({ check: `${ordinal}-${runner}`, verdict: "PIXELS", detail: "machine + runner header and hello marker visible" });
  console.log(`[audit] ${marker} visible in task detail`);
  await page.locator('[aria-label="Back to tasks list"]').click();
  await page.waitForTimeout(1000);
}

async function assertNamedOpenCodeSetup(machine) {
  console.log("[audit] checking desktop OpenCode negative control");
  await selectMachine(machine);
  await selectRunner(machine, "OpenCode");
  const configure = await visibleText(/^Configure$/i);
  const status = await visibleText(/OpenCode needs (setup|sign-in)|OpenCode unavailable/i);
  if (!configure || !status) throw new Error("Unready OpenCode has no named in-place setup route");
  await page.screenshot({ path: join(artifacts, `${safeSlug(machine)}-opencode-named.png`), fullPage: true });
  results.push({ check: "desktop-opencode-negative-control", verdict: "NAMED", detail: "not-ready state and Configure action visible" });
}

async function assertVibingSurface() {
  console.log("[audit] entering Vibing");
  const more = page.getByText("More", { exact: true }).last();
  if (!(await more.isVisible().catch(() => false))) throw new Error("Mobile tab bar has no More entry");
  await more.tap();
  await page.waitForTimeout(8000);
  await page.screenshot({ path: join(artifacts, "more-surface.png"), fullPage: true });
  try {
    const vibe = await visible(page.getByRole("button", { name: "Open Vibing" }));
    if (!vibe) throw new Error("missing named Vibe control");
    await vibe.evaluate((element) => element.click());
  } catch {
    const body = ((await page.locator("body").innerText()) || "").replace(/\s+/g, " ").slice(0, 1800);
    throw new Error(`More did not expose Vibe. URL=${page.url()} Visible text: ${body}`);
  }
  for (let attempt = 0; attempt < 60 && !(await visibleText(/^Vibing$/)); attempt += 1) await page.waitForTimeout(1000);
  if (!(await visibleText(/^Vibing$/))) throw new Error(`Vibe control did not navigate. URL=${page.url()}`);
  const project = await visibleText(/Choose a project to preview/i);
  const named = await visibleText(/Unavailable|Device-local coding|Connect or select a machine/i);
  if (!project && !named) throw new Error("Vibing rendered neither project choice nor named capability state");
  await page.screenshot({ path: join(artifacts, "vibing-surface.png"), fullPage: true });
  results.push({ check: "vibing-entry", verdict: project ? "PIXELS" : "NAMED", detail: project ? "project chooser visible" : "named capability route visible" });
}

async function assertTmuxDiscoveryAndAdoption() {
  console.log("[audit] checking tmux discovery and runner adoption");
  // The live desktop fixture owns the confirmed Codex tmux seat. Scoping this
  // to that selected box also catches inventory leaking in from another box.
  await selectMachine(desktopName);
  const tmux = await visibleText(/^Tmux(?: · \d+)?$/i);
  if (!tmux) throw new Error("Tasks has no Tmux entry");
  await tmux.click({ force: true });
  await page.getByText(/^Tmux Sessions$/).waitFor({ state: "visible", timeout: 30_000 });
  let settled = false;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const scanning = await visibleText(/^(Scanning sessions\.\.\.|Checking machines\.\.\.)$/i);
    if (!scanning) { settled = true; break; }
    await page.waitForTimeout(1000);
  }
  if (!settled) throw new Error("Tmux discovery stayed on an indefinite scanner");
  await page.screenshot({ path: join(artifacts, "tmux-discovery.png"), fullPage: true });
  const namedOutcome = await visibleText(/No tmux sessions|Couldn't scan this machine|tmux-session-|Runner seats/i);
  if (!namedOutcome) throw new Error("Tmux discovery produced neither sessions nor a named result");

  const adopt = await visible(page.getByText(/^Adopt (?:Codex|OpenCode|Claude).*|^Adopt Session$/i));
  if (adopt) {
    const adoptButton = await visible(page.locator('div[tabindex="0"]').filter({ hasText: /^Adopt (?:Codex|OpenCode|Claude).*|^Adopt Session$/i }));
    if (!adoptButton) throw new Error("Visible Adopt label has no tappable control");
    await adoptButton.tap({ force: true });
    for (let attempt = 0; attempt < 45; attempt += 1) {
      if (await visible(page.locator('[aria-label="Back to tasks list"]'))) break;
      const failed = await visibleText(/^Adopt Failed$/i);
      if (failed) throw new Error("Tmux adoption exposed Adopt Failed");
      await page.waitForTimeout(1000);
    }
    if (!(await visible(page.locator('[aria-label="Back to tasks list"]')))) {
      await page.screenshot({ path: join(artifacts, "tmux-adoption-failed.png"), fullPage: true });
      const body = ((await page.locator("body").innerText()) || "").replace(/\s+/g, " ");
      const at = Math.max(body.indexOf("Tmux Sessions"), 0);
      throw new Error(`Tmux adoption did not open its task: ${body.slice(at, at + 1400)}`);
    }
    await page.screenshot({ path: join(artifacts, "tmux-adopted-task.png"), fullPage: true });
    results.push({ check: "tmux-adoption", verdict: "PIXELS", detail: "session adopted and task detail opened" });
  } else {
    results.push({ check: "tmux-discovery", verdict: "NAMED", detail: "scan settled; no unadopted confirmed runner pane was available" });
  }
}

try {
  await seedSession();
  if (!matrixOnly || matrixOnly === "linux-codex") await runHello(linuxName, "Codex", 1);
  if (!matrixOnly || matrixOnly === "linux-opencode") await runHello(linuxName, "OpenCode", 2);
  if (!matrixOnly || matrixOnly === "desktop-codex") await runHello(desktopName, "Codex", 3);
  if (!matrixOnly || matrixOnly === "desktop-opencode") await assertNamedOpenCodeSetup(desktopName);
  if (!matrixOnly || matrixOnly === "vibing") await assertVibingSurface();
  if (!matrixOnly || matrixOnly === "tmux") await assertTmuxDiscoveryAndAdoption();
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ results, consoleErrors, failedResponses }, null, 2));
  await context.close();
  await browser?.close();
}

console.log(JSON.stringify({ results, consoleErrorCount: consoleErrors.length }, null, 2));
