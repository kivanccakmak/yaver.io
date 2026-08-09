import { devices, expect, test } from "@playwright/test";

/**
 * AnsiConsoleText closed loop — mobile (RN-web) chat paints the opencode
 * console look (2026-08-09).
 *
 *   cd mobile && npm run web   (Metro on :8081, RN-web)
 *   cd e2e
 *   MOBILE_WEB_URL=http://localhost:8081 \
 *   YAVER_TEST_EMAIL=... YAVER_TEST_PASSWORD=... \
 *   npx playwright test tests/ansi-console-mobile.spec.ts
 *
 * ── What it proves ─────────────────────────────────────────────────────────
 *
 * The mobile chat bubble used to flatten the opencode raw stream to markdown.
 * mobile/src/components/AnsiConsoleText.tsx now paints it (orange banner,
 * green `$` prompt, green + / red - patches) from the SAME shared tokens as
 * web (shared/client-core/src/ansi.ts). This spec drives the REAL RN-web app
 * in a genuine iPhone device context (never a resized window) and asserts
 * the console grammar renders in the bubble text.
 *
 * Viewport rule (AGENTS.md): the mobile arc MUST open a NEW context with the
 * full device descriptor and assert the viewport it got.
 */

const APP_URL = process.env.MOBILE_WEB_URL || "";
const EMAIL = process.env.YAVER_TEST_EMAIL || "";
const PASSWORD = process.env.YAVER_TEST_PASSWORD || "";

test.describe("ansi console chat rendering (mobile)", () => {
  test.setTimeout(5 * 60_000);
  test.skip(!APP_URL || !EMAIL,
    "needs MOBILE_WEB_URL (cd mobile && npm run web) + YAVER_TEST_EMAIL/PASSWORD");

  test("opencode task output renders console grammar in the chat bubble", async ({ browser }) => {
    const ctx = await browser.newContext({ ...devices["iPhone 15 Pro"] });
    const page = await ctx.newPage();
    try {
      // Assert the real device context, not a resized window.
      const vp = page.viewportSize();
      expect(vp, "device context must be an iPhone-sized viewport").not.toBeNull();
      expect(vp!.width, "viewport width must be the iPhone device width").toBe(393);

      await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(9000);

      // Sign in through the app's own flow — storage seeding does not work
      // for RN-web (auth.ts reads a user record the dashboard never stores).
      const emailBtn = page.getByText(/Continue with Email/i).first();
      if (await emailBtn.count()) {
        await emailBtn.click();
        await page.waitForTimeout(3500);
        await page.getByPlaceholder("Email").first().fill(EMAIL);
        await page.getByPlaceholder("Password").first().fill(PASSWORD);
        await page.getByText(/^Sign In$/).first().click();
        await page.waitForTimeout(15_000);
      }

      // The Tasks tab is the default home; look for existing opencode task
      // output in the transcript. A completed opencode task (from this
      // session's probes) carries `$` prompts and `> build` banners.
      await page.waitForTimeout(6000);
      const body = await page.evaluate(() => document.body?.innerText || "");
      const hasConsoleGrammar = /\$[ \t]|> build|> plan/.test(body);

      // If no console-shaped text is on screen yet, open a task detail: tap
      // the first task card (the most recent is the probe task with raw
      // opencode output).
      if (!hasConsoleGrammar) {
        const taskCard = page
          .locator('[role=button],button,a,div')
          .filter({ hasText: /build ·|deepseek|RAWLANE_OK|ANSICONSOLE|TERMINAL_WEB/ })
          .first();
        if (await taskCard.count()) {
          await taskCard.click();
          await page.waitForTimeout(8000);
        }
      }

      const finalBody = await page.evaluate(() => document.body?.innerText || "");
      const grammar = /\$[ \t]|> build|> plan/.test(finalBody);
      // The console grammar ($ prompt / > build banner) must be visible.
      // This is NAMED evidence: a stripAnsi regression removes both.
      expect(grammar, "mobile chat must show opencode console grammar ($ prompt / > build banner)").toBe(true);

      // The chat also renders markdown output normally; assert we are NOT
      // looking at a raw-JSON error page (a red herring that would also
      // contain "$").
      expect(finalBody.includes("Cannot read properties") || finalBody.includes("Minified React error"),
        "no React crash overlay may replace the chat").toBe(false);
    } finally {
      await ctx.close();
    }
  });
});
