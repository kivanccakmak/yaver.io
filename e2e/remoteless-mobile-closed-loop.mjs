import { chromium, devices } from "@playwright/test";
import process from "node:process";

const appUrl = process.env.MOBILE_WEB_URL;
const profile = process.env.E2E_PROFILE;
if (!appUrl || !profile) {
  throw new Error("MOBILE_WEB_URL and an isolated E2E_PROFILE copy are required");
}

const iphone = devices["iPhone 15 Pro"];
const context = await chromium.launchPersistentContext(profile, {
  ...iphone,
  headless: process.env.HEADED !== "1",
  executablePath: process.env.YAVER_CHROMIUM_PATH || "/Applications/Chromium.app/Contents/MacOS/Chromium",
});

try {
  const page = context.pages()[0] || await context.newPage();
  const viewport = page.viewportSize();
  if (!viewport || viewport.width !== iphone.viewport.width || viewport.height !== iphone.viewport.height) {
    throw new Error(`wrong device context: ${viewport?.width ?? "none"}x${viewport?.height ?? "none"}`);
  }

  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  const go = async (path) => {
    await page.goto(new URL(path, appUrl).href, { waitUntil: "domcontentloaded", timeout: 180_000 });
    await page.waitForTimeout(1_500);
  };

  await go("/devices");
  const noRemote = page.getByLabel("Use no remote box").first();
  await noRemote.waitFor({ state: "visible", timeout: 60_000 });
  await noRemote.click();
  await page.getByText("SELECTED", { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });

  await go("/projects");
  await page.getByText("Phone-local workspace", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  await page.getByText("GitHub & GitLab", { exact: true }).waitFor({ state: "visible" });
  const projectState = await page.locator("body").innerText();
  if (!/On this phone/.test(projectState)) throw new Error("phone projects section did not render");

  await go("/tasks");
  await page.getByText("No remote box", { exact: true }).first().waitFor({ state: "visible", timeout: 60_000 });
  const newTask = page.getByLabel("New task").last();
  await newTask.click();
  await page.getByLabel(/Deep audit/).waitFor({ state: "visible", timeout: 15_000 });
  await page.screenshot({ path: process.env.E2E_SCREENSHOT || "/tmp/yaver-remoteless-mobile.png", fullPage: true });

  const relevantErrors = errors.filter((line) => !/favicon|ResizeObserver/i.test(line));
  console.log(JSON.stringify({
    viewport,
    noRemoteSelected: true,
    projectsVisible: true,
    providerSectionVisible: true,
    taskComposerVisible: true,
    deepAuditVisible: true,
    consoleErrors: relevantErrors.slice(0, 5),
  }));
  if (relevantErrors.length) process.exitCode = 1;
} finally {
  await context.close();
}
