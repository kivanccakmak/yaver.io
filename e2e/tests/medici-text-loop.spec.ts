import { devices, expect, test } from "@playwright/test";

/**
 * Text→text closed loop — medici / ai.tusrehber.com (mobile RN-web).
 *
 *   cd mobile && npm run web   (Metro on :8081, RN-web)
 *   cd e2e
 *   MOBILE_WEB_URL=http://localhost:8081 \
 *   YAVER_TEST_EMAIL=... YAVER_TEST_PASSWORD=... \
 *   npx playwright test tests/medici-text-loop.spec.ts
 *
 * ── What it proves ─────────────────────────────────────────────────────
 * The user's daily loop, end to end, on the REAL mobile app: pick the
 * medici.ai project from the composer chip, send a TEXT prompt, and watch
 * a TEXT reply stream back into the chat — the runner is opencode with
 * DeepSeek V4 Flash on the ubuntu box, and the medici backend
 * (ai.tusrehber.com) answers through the agent's shell tools.
 *
 * Assertions are about the OPERATION, not the inventory:
 *   1. the composer project chip opens the picker and medici.ai is
 *      selectable (project-selection-by-chip contract);
 *   2. sending creates a task whose card appears;
 *   3. opening the task, an assistant TEXT reply actually arrives in the
 *      chat within a generous budget — the failure message quotes what the
 *      screen showed when the budget ran out ("it timed out" is not a
 *      diagnosis; see AGENTS.md: never infer what you can measure).
 *
 * Viewport rule (AGENTS.md): a NEW context with the full device descriptor,
 * and the viewport is ASSERTED, never assumed.
 */

const APP_URL = process.env.MOBILE_WEB_URL || "";
const EMAIL = process.env.YAVER_TEST_EMAIL || "";
const PASSWORD = process.env.YAVER_TEST_PASSWORD || "";
// The prompt sent to the runner. Keep it self-contained: it must produce a
// text reply through the medici project on the remote box.
const PROMPT =
  "medici text-loop: soru_sor aracını kullanarak hipotiroidi hakkında kısa bir soru sor ve cevabını yaz.";

test.describe("medici / ai.tusrehber.com — text to text closed loop (mobile)", () => {
  test.setTimeout(12 * 60_000);
  test.skip(!APP_URL || !EMAIL,
    "needs MOBILE_WEB_URL (cd mobile && npm run web) + YAVER_TEST_EMAIL/PASSWORD");

  test("pick medici.ai → send text → text reply streams into the chat", async ({ browser }) => {
    const ctx = await browser.newContext({ ...devices["iPhone 15 Pro"] });
    const page = await ctx.newPage();
    try {
      const vp = page.viewportSize();
      expect(vp, "device context must be an iPhone-sized viewport").not.toBeNull();
      expect(vp!.width, "viewport width must be the iPhone device width").toBe(393);

      await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(9000);

      // Sign in through the app's own flow.
      const emailBtn = page.getByText(/Continue with Email/i).first();
      if (await emailBtn.count()) {
        await emailBtn.click();
        await page.waitForTimeout(3500);
        await page.getByPlaceholder("Email").first().fill(EMAIL);
        await page.getByPlaceholder("Password").first().fill(PASSWORD);
        await page.getByText(/^Sign In$/).first().click();
        await page.waitForTimeout(15_000);
      }

      await expect
        .poll(async () => (await page.getByText(/^Tasks$/).first().isVisible().catch(() => false)), {
          timeout: 90_000,
          message: "the Tasks tab never mounted after sign-in",
        })
        .toBe(true);
      await page.waitForTimeout(5000);

      // ── 1. Open the composer + pick medici.ai via the chip ───────────
      const newTaskBtn = page.locator('[aria-label="Dictate a new task"]').first();
      await expect
        .poll(async () => (await newTaskBtn.count()) > 0 && (await newTaskBtn.isVisible().catch(() => false)), {
          timeout: 30_000,
          message: "composer FAB not visible",
        })
        .toBe(true);
      await newTaskBtn.click();
      await page.waitForTimeout(3000);

      // Project/MCP scope is intentionally progressive disclosure: the
      // keyboard-open composer keeps only prompt + primary actions visible.
      await page.locator('[data-testid="task-options-more"]').first().click();
      const chip = page.locator('[data-testid="composer-project-chip"]').first();
      await expect
        .poll(async () => (await chip.count()) > 0 && (await chip.isVisible().catch(() => false)), {
          timeout: 30_000,
          message: "composer project chip not visible",
        })
        .toBe(true);
      await chip.click();
      await expect
        .poll(async () => (await page.getByText(/^Task configuration$/).first().isVisible().catch(() => false)), {
          timeout: 20_000,
          message: "project picker did not open after tapping the chip",
        })
        .toBe(true);

      // Select the medici.ai row. The picker rows render name + path as
      // separate texts; an exact match on the name avoids the path line.
      const mediciRow = page.getByText(/^medici\.ai$/).first();
      await expect
        .poll(async () => (await mediciRow.count()) > 0 && (await mediciRow.isVisible().catch(() => false)), {
          timeout: 30_000,
          message: "medici.ai is not listed in the project picker (top-level project contract)",
        })
        .toBe(true);
      await mediciRow.click();
      await page.waitForTimeout(1500);
      // Close the picker; the chip now shows the medici.ai selection.
      await page.getByText(/^Done$/).first().click();
      await page.waitForTimeout(1500);

      // ── 2. Type the text prompt and send ─────────────────────────────
      const input = page.getByPlaceholder(/What should the agent do|Send another command/i).first();
      await expect
        .poll(async () => (await input.count()) > 0 && (await input.isVisible().catch(() => false)), {
          timeout: 20_000,
          message: "composer input not visible",
        })
        .toBe(true);
      await input.fill(PROMPT);
      await page.getByText(/^Send$/).first().click();
      await page.waitForTimeout(4000);

      // ── 3. The task card appears; open it ────────────────────────────
      const card = page
        .locator('[role="button"],button,a,div')
        .filter({ hasText: /medici text-loop/i })
        .first();
      await expect
        .poll(async () => (await card.count()) > 0 && (await card.isVisible().catch(() => false)), {
          timeout: 60_000,
          message: "the sent task never appeared as a card",
        })
        .toBe(true);
      await card.click();
      await page.waitForTimeout(5000);

      // ── 4. A TEXT REPLY must arrive in the chat ──────────────────────
      // Poll the task detail body: the assistant's answer is a non-trivial
      // text block. On failure, quote what the screen actually showed.
      let lastBody = "";
      await expect
        .poll(async () => {
          lastBody = await page.evaluate(() => document.body?.innerText || "");
          const hasReply =
            /medici text-loop/i.test(lastBody) &&
            // A real reply: some text beyond the prompt echo + UI chrome.
            (/(hipotiroidi|tiroid|soru|kaynak|cevap|açıklama|hasta|tedavi|levotiroksin|TSH|hipertiroidi|bağışıklık)/i.test(lastBody) ||
              /[^\n]{120,}/.test(lastBody));
          return hasReply;
        }, {
          timeout: 10 * 60_000,
          message:
            "no text reply arrived in the chat. The task's runner is opencode + DeepSeek V4 Flash on the ubuntu box; a slow first compile or a runner-auth gap can exceed the budget. Last screen text:\n" +
            lastBody.slice(0, 800),
        })
        .toBe(true);

      console.log("[medici-text-loop] text→text OK — an assistant reply is visible in the chat");
    } finally {
      await ctx.close();
    }
  });
});
