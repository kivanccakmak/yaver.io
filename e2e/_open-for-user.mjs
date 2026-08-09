// Headful Chrome at iPhone 15 Pro viewport, signed in, kept open for the user.
import { devices, chromium } from "@playwright/test";
const APP_URL = process.env.MOBILE_WEB_URL;
const EMAIL = process.env.YAVER_TEST_EMAIL;
const PASSWORD = process.env.YAVER_TEST_PASSWORD;
const browser = await chromium.launch({ headless: false, args: ["--start-maximized"] });
const ctx = await browser.newContext({ ...devices["iPhone 15 Pro"], viewport: { width: 393, height: 852 } });
const page = await ctx.newPage();
console.log("[open-for-user] context viewport:", JSON.stringify(page.viewportSize()));
await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 180000 });
await page.waitForTimeout(9000);
const emailBtn = page.getByText(/Continue with Email/i).first();
if (await emailBtn.count()) {
  await emailBtn.click();
  await page.waitForTimeout(4000);
  await page.getByPlaceholder("Email").first().fill(EMAIL);
  await page.getByPlaceholder("Password").first().fill(PASSWORD);
  await page.getByText(/^Sign In$/).first().click();
  await page.waitForTimeout(18000);
}
const body = await page.evaluate(() => (document.body.innerText || "").split("\n").map(l => l.trim()).filter(Boolean).slice(0, 8));
console.log("[open-for-user] signed in, top of screen:", JSON.stringify(body));
// Keep the browser open until the user closes it or this process is killed.
await new Promise(() => {});
