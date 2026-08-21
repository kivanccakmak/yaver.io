import { chromium, devices } from "playwright";

const appURL = (process.env.MOBILE_WEB_URL || "").replace(/\/$/, "");
const token = process.env.YAVER_TEST_TOKEN || "";
if (!appURL || !token) {
  throw new Error("MOBILE_WEB_URL and YAVER_TEST_TOKEN are required");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const iphone = devices["iPhone 15 Pro"];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext(iphone);
await context.addInitScript((authToken) => {
  localStorage.setItem("yaver.secure.yaver_auth_token", authToken);
}, token);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});

try {
  await page.goto(`${appURL}/phone-projects`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.getByText("Mobile Workspace", { exact: true }).waitFor({ timeout: 60_000 });
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
  await page.getByText(/Primary device · Recommended|Connected machine|Other online box|Connect a Yaver machine first/).first().waitFor({ timeout: 30_000 });
  const placement = await page.locator("body").innerText().then((text) => ({
    primary: text.includes("Primary device · Recommended"),
    connected: text.includes("Connected machine"),
    other: text.includes("Other online box"),
    missing: text.includes("Connect a Yaver machine first"),
  }));
  assert(placement.primary, `primary recommendation missing: ${JSON.stringify(placement)}`);
  await page.getByText(/OpenCode · (Preferred|Recommended)/).waitFor({ timeout: 30_000 });
  await page.getByText("Ready", { exact: true }).first().waitFor({ timeout: 30_000 });
  await page.getByText("deepseek/deepseek-v4-flash", { exact: true }).waitFor({ timeout: 30_000 });
  const targetText = await page.locator("body").innerText();
  assert(!/remoteless/i.test(targetText), "Mobile Workspace must not offer Remoteless placement");
  assert(/Yaver Serverless/i.test(targetText), "fixed Yaver Serverless stack is not visible");

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

  assert(errors.length === 0, `Mobile Workspace browser errors:\n${errors.join("\n")}`);
  console.log("live Mobile Workspace onboarding passed");
} finally {
  await context.close();
  await browser.close();
}
