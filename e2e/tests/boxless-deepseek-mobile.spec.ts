import { devices, expect, test, type Browser } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { profileFor, viewportMatchesSurface, type YaverSurface } from "../../web/lib/surfaceViewports";

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
const TOKEN = process.env.YAVER_TEST_TOKEN || "";
const RECORD_ALL = process.env.E2E_RECORD_ALL === "1";

const localFixture = {
  slug: "hello-remoteless",
  name: "Hello Remoteless",
  template: "blank",
  dir: "",
  createdAt: "2026-08-22T00:00:00.000Z",
  updatedAt: "2026-08-22T00:00:00.000Z",
  schema: { tables: [] },
  auth: { personas: [] },
  app: { summary: "Disposable browser-automation checkout" },
};

async function openSurface(browser: Browser, surface: "mobile" | "tablet") {
  const profile = profileFor(surface);
  const descriptorName = surface === "mobile" ? "iPhone 15 Pro" : profile.playwrightDevice!;
  const recordingDir = `test-results/remoteless-recordings/${surface}`;
  if (RECORD_ALL) await mkdir(recordingDir, { recursive: true });
  const context = await browser.newContext({
    ...devices[descriptorName],
    ...(RECORD_ALL ? { recordVideo: { dir: recordingDir, size: devices[descriptorName].viewport } } : {}),
  });
  const page = await context.newPage();
  await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.evaluate(({ token, fixture }: { token: string; fixture: typeof localFixture }) => {
    localStorage.setItem("yaver_installed", "1");
    localStorage.setItem("yaver.secure.yaver_auth_token", token);
    localStorage.setItem(`@yaver/local_phone_project_meta/${encodeURIComponent(fixture.slug)}`, JSON.stringify(fixture));
  }, { token: TOKEN, fixture: localFixture });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8_000);

  const observed = await page.evaluate(() => ({
    // surfaceViewports tracks the browser's visible layout viewport. Device
    // descriptors expose a taller physical screen separately (393x852 for an
    // iPhone 15), so screen.height would reject the correct 393x659 viewport.
    width: window.innerWidth,
    height: window.innerHeight,
    hasTouch: "ontouchstart" in window || navigator.maxTouchPoints > 0,
    isMobile: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent),
  }));
  const match = viewportMatchesSurface(surface as YaverSurface, observed);
  expect(match.ok, match.reason).toBe(true);
  await expect(page.getByText(/Continue with Email|Sign In to drive/i)).toHaveCount(0);
  return { context, page };
}

test.describe("boxless DeepSeek mobile entry point", () => {
  test.skip(!APP_URL, "needs MOBILE_WEB_URL pointing at the RN-web Metro app");

  test.describe("No remote box workflow", () => {
    test.skip(!TOKEN, "needs YAVER_TEST_TOKEN for authenticated Devices, Projects, and Tasks surfaces");

    for (const surface of ["mobile", "tablet"] as const) {
      test(`${surface} selects No remote box, browses local projects, and reaches the DeepSeek composer`, async ({ browser }) => {
        const { context, page } = await openSurface(browser, surface);
        try {
          const dialogs: string[] = [];
          page.on("dialog", (dialog) => {
            dialogs.push(dialog.message());
            void dialog.dismiss();
          });
          // Navigate as the user does. A direct deep-link remounts the entire
          // provider tree and can race the initial automatic connection sweep;
          // the product contract here is the visible More → Devices route.
          await page.getByText("More", { exact: true }).last().tap();
          await page.getByText("Devices", { exact: true }).tap();
          const noRemote = page.getByLabel("Use no remote box").first();
          await expect(noRemote).toBeVisible({ timeout: 60_000 });
          await expect(noRemote).toBeEnabled({ timeout: 60_000 });
          // This is a touch surface. A real tap exercises RN Pressable's mobile
          // event path; DOM click is a desktop event and was intermittently
          // ignored by the touch responder while still looking successful to
          // Playwright.
          await noRemote.tap();
          await page.waitForTimeout(500);
          expect(dialogs, "No remote box selection must not fail behind an alert").toEqual([]);
          const persistedModes = await page.evaluate(() => Object.keys(localStorage)
            .filter((key) => key.endsWith("/execution_mode"))
            .map((key) => localStorage.getItem(key)));
          expect(persistedModes, "No remote box selection must persist local-only before it paints").toContain("local-only");
          // React Native Web does not serialize accessibilityState.selected as
          // aria-selected on a button. The product's named, visible state is
          // the SELECTED label inside this exact control.
          await expect(noRemote.getByText("SELECTED", { exact: true })).toBeVisible();

          await page.getByText("Projects", { exact: true }).last().tap();
          await expect(page.getByText("Phone-local workspace", { exact: true })).toBeVisible({ timeout: 60_000 });
          await expect(page.getByText("GitHub & GitLab", { exact: true })).toBeVisible();
          const checkout = page.getByText(localFixture.name, { exact: true });
          await expect(checkout).toBeVisible();
          await checkout.click();

          await expect(page.getByText(/ON THIS PHONE|No remote box/i).first()).toBeVisible({ timeout: 60_000 });
          await page.getByLabel("More task options").click();
          await expect(page.getByLabel("This phone, DeepSeek")).toBeVisible();
          await expect(page.getByLabel("Change device, coding agent, and model for this task")).toHaveCount(0);
          await expect(page.getByLabel(/Deep audit/)).toBeVisible();
        } finally {
          await context.close();
        }
      });
    }
  });

  test("opens on an iPhone context and saves the DeepSeek V4 Flash credential without leaking it", async ({ browser }) => {
    const recordingDir = "test-results/remoteless-recordings/deepseek-credential";
    if (RECORD_ALL) await mkdir(recordingDir, { recursive: true });
    const ctx = await browser.newContext({
      ...devices["iPhone 15 Pro"],
      ...(RECORD_ALL ? { recordVideo: { dir: recordingDir, size: devices["iPhone 15 Pro"].viewport } } : {}),
    });
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
