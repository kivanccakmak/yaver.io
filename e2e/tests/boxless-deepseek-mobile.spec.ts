import { devices, expect, test } from "@playwright/test";

/**
 * Boxless DeepSeek entry point on the real RN-web mobile surface.
 *
 * This deliberately uses a throwaway fake key and never calls DeepSeek. The
 * agent loop is covered by mobile-headless tests; this arc proves the user can
 * reach the boxless screen at a genuine mobile viewport, save the provider
 * credential through the UI, and that the credential is not painted into the
 * page. Native builds use SecureStore/Keychain; web uses the documented
 * dev-origin compatibility store.
 */
const APP_URL = process.env.MOBILE_WEB_URL || "";

test.describe("boxless DeepSeek mobile entry point", () => {
  test.skip(!APP_URL, "needs MOBILE_WEB_URL pointing at the RN-web Metro app");

  test("opens on an iPhone context and saves the DeepSeek V4 Flash credential without leaking it", async ({ browser }) => {
    const ctx = await browser.newContext({ ...devices["iPhone 15 Pro"] });
    const page = await ctx.newPage();
    const fakeKey = "sk-boxless-playwright-fake-never-real";
    try {
      await page.goto(`${APP_URL}/repo-coding`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(2_000);

      const viewport = page.viewportSize();
      expect(viewport?.width, "RN-web must run in a real iPhone context").toBe(393);
      expect(await page.evaluate(() => ({ touch: "ontouchstart" in window, mobile: /Mobile|iPhone|CriOS/.test(navigator.userAgent) })))
        .toEqual({ touch: true, mobile: true });

      const body = () => page.locator("body").innerText();
      expect(await body()).toContain("Yaver Agent · DeepSeek V4 Flash");
      expect(await body()).toContain("no remote box");
      expect(await body()).toContain("GitLab token");

      await page.getByPlaceholder("Paste key").first().fill(fakeKey);
      await page.getByText("Save", { exact: true }).first().click();
      await expect(page.getByText("saved", { exact: true }).first()).toBeVisible();

      const evidence = await page.evaluate((key) => ({
        persisted: localStorage.getItem("yaver.secure.yaver_key_deepseek_api_key") === key,
        visible: (document.body?.innerText || "").includes(key),
      }), fakeKey);
      expect(evidence.persisted).toBe(true);
      expect(evidence.visible).toBe(false);
    } finally {
      // Do not leave even a fake credential in a persistent test origin.
      await page.evaluate(() => localStorage.removeItem("yaver.secure.yaver_key_deepseek_api_key")).catch(() => undefined);
      await ctx.close();
    }
  });
});
