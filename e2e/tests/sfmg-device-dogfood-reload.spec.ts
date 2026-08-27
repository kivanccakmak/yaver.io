import { devices, expect, test } from "@playwright/test";
import { profileFor, viewportMatchesSurface } from "../../web/lib/surfaceViewports";

const AGENT = (process.env.E2E_AGENT_URL || "http://127.0.0.1:18080").replace(/\/$/, "");
const TOKEN = process.env.YAVER_TEST_TOKEN || "";

test("SFMG browser Dogfood remains visible through fast and full reload", async ({ browser, request }) => {
  test.skip(!TOKEN, "YAVER_TEST_TOKEN is required for the authenticated agent lane");

  const profile = profileFor("mobile");
  if (!profile.playwrightDevice) throw new Error("mobile surface has no Playwright device descriptor");
  const descriptor = devices[profile.playwrightDevice];
  if (!descriptor) throw new Error(`Playwright device ${profile.playwrightDevice} is unavailable`);

  const context = await browser.newContext({
    ...descriptor,
    extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` },
  });
  const page = await context.newPage();

  try {
    const viewport = page.viewportSize();
    const observed = {
      width: viewport?.width || 0,
      height: viewport?.height || 0,
      isMobile: descriptor.isMobile,
      hasTouch: descriptor.hasTouch,
    };
    const matched = viewportMatchesSurface("mobile", observed, 0);
    expect(matched.ok, matched.reason).toBe(true);

    const response = await page.goto(`${AGENT}/dev/`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    expect(response?.status(), "authenticated SFMG document status").toBe(200);
    await expect(page).toHaveTitle(/SFMG/i);
    await expect(page.locator("#root")).not.toBeEmpty();
    await expect(page.locator("body")).toContainText(/SFMG|Choose Your Language|Türkçe|English/i);
    await page.screenshot({ path: "test-results/sfmg-dogfood-before-reload.png", fullPage: true });

    for (const mode of ["fast", "full"] as const) {
      const reload = await request.post(`${AGENT}/dev/reload`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
        data: { mode },
      });
      const body = await reload.text();
      expect(reload.ok(), `${mode} reload failed: ${body.slice(0, 500)}`).toBe(true);
      await page.waitForLoadState("domcontentloaded");
      await expect(page).toHaveTitle(/SFMG/i);
      await expect(page.locator("#root")).not.toBeEmpty();
      await expect(page.locator("body")).toContainText(/SFMG|Choose Your Language|Türkçe|English/i);
    }

    await page.screenshot({ path: "test-results/sfmg-dogfood-after-full-reload.png", fullPage: true });

    // The exact route that exposed the missing-settings bug must never be a
    // blank modal when opened without transient achievement state. It provides
    // a named route to Settings, which is otherwise hidden with Profile until
    // season two.
    await page.goto(`${AGENT}/dev/modals/achievement`, { waitUntil: "domcontentloaded" });
    // React Native Web renders TouchableOpacity as a focusable div, not a
    // native HTML button. Query the actual interactive contract instead of
    // assigning it a role the product does not emit.
    const settingsButton = page
      .locator('[tabindex="0"]')
      .filter({ hasText: /Settings|Ayarlar/i })
      .first();
    await expect(settingsButton).toBeVisible();
    await settingsButton.click();
    await expect(page).toHaveURL(/\/settings/);
    await expect(page.getByText(/Sound Effects|Ses Efektleri/i)).toBeVisible();
    await expect(page.getByText(/Notifications|Bildirimler/i)).toBeVisible();
    const dogfoodAction = page.getByText('Dogfood SFMG', { exact: true });
    await expect(dogfoodAction).toHaveCount(1);
    await expect(dogfoodAction).toBeVisible();
    await expect(page.getByText(/Sign Out|Çıkış/i)).toBeVisible();

    // Dogfood is an account/device onboarding path, not the shake/debug
    // capture toggle. Turning Feedback SDK off must not unmount the event
    // consumer and turn this visible action into a silent no-op.
    const feedbackRow = page.getByText('Feedback SDK', { exact: true }).locator('..').locator('..');
    const feedbackToggle = feedbackRow.getByRole('switch');
    if (await feedbackToggle.isChecked()) await feedbackToggle.click();
    await expect(feedbackToggle).not.toBeChecked();
    await dogfoodAction.click();
    await expect(page.getByText('Sign in to send feedback')).toBeVisible();
    await expect(page.getByText('Continue with Apple')).toBeVisible();
    await page.screenshot({ path: "test-results/sfmg-settings-dogfood.png", fullPage: true });
  } finally {
    await context.close();
  }
});
