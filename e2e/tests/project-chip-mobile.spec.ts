import { devices, expect, test } from "@playwright/test";

/**
 * Project chip closed loop — mobile (RN-web): top-level-only project list,
 * chip-onclick opens the picker, no chat/console discrimination.
 *
 *   cd mobile && npm run web   (Metro on :8081, RN-web)
 *   cd e2e
 *   MOBILE_WEB_URL=http://localhost:8081 \
 *   YAVER_TEST_EMAIL=... YAVER_TEST_PASSWORD=... \
 *   npx playwright test tests/project-chip-mobile.spec.ts
 *
 * ── What each assertion would have caught ─────────────────────────────────
 *
 * 1. The project/MCP chip opened its picker as a SECOND native <Modal>
 *    while the composer Modal was up. iOS cannot present a second native
 *    Modal — it mounts invisibly behind the first — so the tap "did
 *    nothing". The fix renders the sheet as an absolute overlay INSIDE the
 *    composer Modal. The assertion "the picker must appear on screen within
 *    the budget after the chip tap" fails on the old code (the sheet never
 *    becomes visible) and passes on the fix.
 *
 * 2. The picker leaked SUB-PROJECT rows: nested git clones
 *    (yaver.io/mobile inside yaver.io) surfaced as their own "mobile"
 *    project, and monorepo-app labels ("yaver.io / mobile", "talos
 *    frontend") were seeded into the Convex catalog. Contract: TOP-LEVEL
 *    ONLY — medici.ai, yaver.io, talos, sfmg. Assertion: no two visible
 *    project rows may have one path inside the other (component-wise), and
 *    no row name may carry a "<root> / <app>" label. If the box has zero
 *    projects the sheet must say so NAMED — never hang silently.
 *
 * 3. The follow-up composer (chat) and the Terminal/console composer had no
 *    project chip — project selection discriminated between surfaces.
 *    Assertion: the expanded follow-up composer shows the SAME project
 *    chip (data-testid="followup-project-chip").
 *
 * Viewport rule (AGENTS.md): a NEW context with the full device descriptor,
 * and the viewport is ASSERTED, never assumed.
 */

const APP_URL = process.env.MOBILE_WEB_URL || "";
const EMAIL = process.env.YAVER_TEST_EMAIL || "";
const PASSWORD = process.env.YAVER_TEST_PASSWORD || "";

/** Component-wise: is `path` inside `root`? Same rule as the app's
 * collapseNestedComposerProjects / agent collapseNestedRepos. */
function pathIsInside(path: string, root: string): boolean {
  const p = String(path || "").replace(/\/+$/, "");
  const r = String(root || "").replace(/\/+$/, "");
  if (!p || !r || r === p) return false;
  return p.startsWith(r + "/");
}

test.describe("project chip — top-level only, no chat/console discrimination (mobile)", () => {
  test.setTimeout(7 * 60_000);
  test.skip(!APP_URL || !EMAIL,
    "needs MOBILE_WEB_URL (cd mobile && npm run web) + YAVER_TEST_EMAIL/PASSWORD");

  test("composer chip opens the picker; picker is top-level only; follow-up composer has the chip", async ({ browser }) => {
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

      // The Tasks tab must mount (session may have survived — then it is
      // already here).
      await expect
        .poll(async () => (await page.getByText(/^Tasks$/).first().isVisible().catch(() => false)), {
          timeout: 90_000,
          message: "the Tasks tab never mounted after sign-in",
        })
        .toBe(true);
      await page.waitForTimeout(5000);

      // ── 1. Composer chip opens the picker ────────────────────────────
      // Open the composer via the phone FAB (accessibilityLabel → aria-label;
      // "Dictate a new task" opens the composer and starts dictation, which
      // fails silently in a headless browser — the composer stays open). The
      // tablet dual-pane "+" (aria-label "New task") is a second, equivalent
      // entry point for tablets.
      const newTaskBtn = page
        .locator('[aria-label="Dictate a new task"], [aria-label="New task"]')
        .first();
      await expect
        .poll(async () => (await newTaskBtn.count()) > 0 && (await newTaskBtn.isVisible().catch(() => false)), {
          timeout: 30_000,
          message: "composer entry button (FAB / tablet +) not visible on the Tasks tab",
        })
        .toBe(true);
      await newTaskBtn.click();
      await page.waitForTimeout(3000);

      const chip = page.locator('[data-testid="composer-project-chip"]').first();
      await expect
        .poll(async () => (await chip.count()) > 0 && (await chip.isVisible().catch(() => false)), {
          timeout: 30_000,
          message: "composer project chip not visible after opening the composer",
        })
        .toBe(true);

      await chip.click();
      await expect
        .poll(async () => (await page.getByText(/^Task configuration$/).first().isVisible().catch(() => false)), {
          timeout: 20_000,
          message:
            "project picker did NOT appear after tapping the chip — the second-native-Modal regression: the sheet used to mount invisibly behind the composer and the tap 'did nothing'",
        })
        .toBe(true);

      // ── 2. Top-level-only project list ───────────────────────────────
      // Slice the sheet's text between its title and the MCP section, then
      // assert the invariant: no row's path may live inside another row's
      // path, and no row name may carry a "<root> / <app>" monorepo label.
      const body = await page.evaluate(() => document.body?.innerText || "");
      const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
      const start = lines.findIndex((l) => l === "Task configuration");
      const end = lines.findIndex((l, i) => i > start && l === "MCP SERVERS");
      const sheet = lines.slice(start + 1, end === -1 ? undefined : end);

      const paths = sheet.filter((l) => l.startsWith("/"));
      const names = sheet.filter((l) => !l.startsWith("/") && !/^Keep last project|Auto-select/.test(l));

      if (paths.length === 0) {
        // No projects reported (not connected / empty box): the sheet must
        // say so in words — a NAMED state, never a silent hang.
        const named = sheet.some((l) => /No projects reported/i.test(l));
        expect(named, "with zero projects the sheet must say so (NAMED), not hang silently").toBe(true);
        console.log("[project-chip] NAMED: no projects reported by the runner — top-level invariant not applicable, empty state is honest");
      } else {
        // The core Snowball assertion: the list must be top-level only.
        for (let i = 0; i < paths.length; i += 1) {
          for (let j = 0; j < paths.length; j += 1) {
            if (i === j) continue;
            expect(
              pathIsInside(paths[i], paths[j]),
              `nested sub-project leaked into the picker: ${paths[i]} is inside ${paths[j]}`,
            ).toBe(false);
          }
        }
        // No monorepo-app labels ("yaver.io / mobile", "talos / frontend").
        for (const name of names) {
          expect(name.includes(" / "), `monorepo-app label surfaced as a pickable project: "${name}"`).toBe(false);
        }
        console.log(`[project-chip] top-level invariant OK — ${paths.length} project row(s), no nested paths, no "<root> / <app>" labels`);
      }

      // Close the picker (Done), then close the composer.
      await page.getByText(/^Done$/).first().click();
      await page.waitForTimeout(1500);
      const closeComposer = page.locator('[aria-label="Close new task"]').first();
      if ((await closeComposer.count()) > 0 && (await closeComposer.isVisible().catch(() => false))) {
        await closeComposer.click();
        await page.waitForTimeout(2000);
      }

      // ── 3. No chat/console discrimination: the follow-up composer has
      //       the SAME project chip. ────────────────────────────────────
      // Open a task detail: tap the first task card (runner/model text is
      // what distinguishes a card from the cockpit controls).
      const card = page
        .locator('[role="button"],button,a,div')
        .filter({ hasText: /deepseek|claude|codex|opencode|build ·|plan/i })
        .first();
      if (await card.count().catch(() => 0)) {
        await card.click();
        await page.waitForTimeout(6000);
        // Expand the follow-up composer (compact bar → full card).
        const followUpBar = page.getByText(/Follow up — or send another command/i).first();
        if (await followUpBar.isVisible().catch(() => false)) {
          await followUpBar.click();
          await page.waitForTimeout(2500);
          const followUpChip = page.locator('[data-testid="followup-project-chip"]').first();
          await expect
            .poll(async () => (await followUpChip.count()) > 0 && (await followUpChip.isVisible().catch(() => false)), {
              timeout: 20_000,
              message:
                "the follow-up composer has NO project chip — chat/console discrimination: a follow-up task must offer the same project+MCP selection as a fresh task",
            })
            .toBe(true);
          console.log("[project-chip] follow-up composer exposes the project chip — chat and console composers share the affordance");
        } else {
          console.log("[project-chip] NAMED: no follow-up bar found in the opened task detail");
        }
      } else {
        console.log("[project-chip] NAMED: no task card found — follow-up parity sub-test skipped (account has no tasks)");
      }
    } finally {
      await ctx.close();
    }
  });
});
