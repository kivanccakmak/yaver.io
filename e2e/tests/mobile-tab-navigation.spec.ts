import { devices, expect, test } from "@playwright/test";

/**
 * Mobile tab navigation: the ROUTE changing is not the VIEW changing.
 *
 * ── The defect (measured 2026-08-02, RN-web build) ─────────────────────────
 *
 * Tapping the "Projects" bottom tab changes the URL to /apps — and the screen
 * keeps rendering the Tasks list ("Active · N", "Review · N"). A full
 * goto('/apps') renders the Projects screen correctly, so the screen itself is
 * fine: client-side tab navigation re-routes without re-rendering.
 *
 * The project/preview surface is therefore unreachable by tapping, which is the
 * only way a real user gets there.
 *
 * ── Why this is its own spec ───────────────────────────────────────────────
 *
 * The vibe loop routes around this with goto() so it can test the arc it exists
 * to test. Routing around a defect is fine; letting that hide it is not. This
 * spec fails until tapping works, so the workaround cannot quietly become the
 * permanent answer.
 *
 * ── Why it asserts the VIEW and never page.url() ───────────────────────────
 *
 * Because the URL is CORRECT. A URL assertion passes on this bug, and the suite
 * would report green about a screen the user can never reach — the exact
 * false-green shape this whole suite is built around. It was one line away.
 */
test.describe("mobile tab navigation", () => {
  const MOBILE_URL = process.env.MOBILE_WEB_URL || "";
  test.skip(!MOBILE_URL || !process.env.YAVER_TEST_EMAIL,
    "needs MOBILE_WEB_URL (cd mobile && npm run web) + YAVER_TEST_EMAIL/PASSWORD");
  test.describe.configure({ timeout: 5 * 60_000 });

  test("tapping Projects renders the Projects screen, not just a new URL", async ({ browser }) => {
    const ctx = await browser.newContext({ ...devices["iPhone 15"] });
    const page = await ctx.newPage();
    try {
      await page.goto(MOBILE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(9000);

      // Sign in through the app's own flow — seeding storage does not work
      // (auth.ts reads a user record the web dashboard never stores).
      const emailBtn = page.getByText(/Continue with Email/i).first();
      if (await emailBtn.count()) {
        await emailBtn.click();
        await page.waitForTimeout(3500);
        await page.getByPlaceholder("Email").first().fill(process.env.YAVER_TEST_EMAIL!);
        await page.getByPlaceholder("Password").first().fill(process.env.YAVER_TEST_PASSWORD!);
        await page.getByText(/^Sign In$/).first().click();
        await page.waitForTimeout(15_000);
      }

      // Tab labels render doubled (icon + label), so an exact-text match misses.
      await page.locator('[role=button],button,a').filter({ hasText: /Projects/ }).last().click();
      await page.waitForTimeout(10_000);

      const view = await page.evaluate(() => document.body?.innerText || "");
      const stillOnTasks = /Active · \d|Review · \d/.test(view);

      expect(stillOnTasks,
        `the tab changed the route to ${page.url()} but the VIEW is still the Tasks list. ` +
        `A full goto('/apps') renders Projects correctly, so the screen is fine and client-side ` +
        `tab navigation is re-routing without re-rendering. Asserted on the VIEW because the URL ` +
        `is correct — a url() assertion passes on this bug.`).toBe(false);

      expect(view, "the Projects screen should be showing after the tap").toMatch(/Projects/);
    } finally {
      await ctx.close().catch(() => {});
    }
  });
});
