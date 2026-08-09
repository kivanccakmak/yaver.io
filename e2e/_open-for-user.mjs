import { devices, chromium } from "@playwright/test";
const APP_URL = process.env.MOBILE_WEB_URL;
const EMAIL = process.env.YAVER_TEST_EMAIL;
const PASSWORD = process.env.YAVER_TEST_PASSWORD;
const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ ...devices["iPhone 15 Pro"], viewport: { width: 393, height: 852 } });
const page = await ctx.newPage();
console.log("[open-for-user] viewport:", JSON.stringify(page.viewportSize()));
await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 180000 });
await page.waitForTimeout(9000);
// Robust email sign-in: poll for the CTA, click, fill, submit.
const emailCta = page.getByText(/Continue with Email/i).first();
let signedIn = false;
for (let i = 0; i < 12; i += 1) {
  if (await emailCta.isVisible().catch(() => false)) break;
  await page.waitForTimeout(5000);
}
if (await emailCta.isVisible().catch(() => false)) {
  await emailCta.click();
  await page.waitForTimeout(4000);
  const em = page.getByPlaceholder("Email").first();
  const pw = page.getByPlaceholder("Password").first();
  if (await em.isVisible().catch(() => false)) {
    await em.fill(EMAIL);
    await pw.fill(PASSWORD);
    await page.getByText(/^Sign In$/).first().click();
    await page.waitForTimeout(20000);
  }
}
const body = await page.evaluate(() => (document.body.innerText || "").split("\n").map(l => l.trim()).filter(Boolean).slice(0, 14));
signedIn = body.some(l => /^Tasks$|^Projects$/.test(l));
console.log("[open-for-user]", signedIn ? "SIGNED IN" : "LOGIN SCREEN (complete manually if needed)", JSON.stringify(body));
await new Promise(() => {}); // keep the window open
