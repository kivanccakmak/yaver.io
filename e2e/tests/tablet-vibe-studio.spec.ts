import { devices, expect, test } from "@playwright/test";
import { profileFor, viewportMatchesSurface } from "../../web/lib/surfaceViewports";

/**
 * Tablet Vibe Studio — landscape split / portrait peek closed loop.
 *
 *   npx --prefix e2e playwright test tablet-vibe-studio.spec.ts
 *
 * ── What it proves ─────────────────────────────────────────────────────────
 *
 * The Vibe Studio (mobile/app/vibe-studio.tsx) renders the tvOS/web-shaped
 * split on a ~10" Android tablet:
 *   • landscape (Galaxy Tab S9 landscape profile) — preview pane LEFT (browser
 *     or live lane) + chat pane RIGHT, with the lane switcher visible;
 *   • portrait (iPad gen 7 profile, same tablet class) — single-pane chat with
 *     a "Preview" peek tab, NO lane switcher.
 *
 * ── Why a device context, and why assert it ────────────────────────────────
 *
 * A tablet is a DEVICE CONTEXT, not a viewport size. useResponsiveLayout
 * branches on short-edge >= 600 and orientation — a narrowed desktop renders
 * the phone tree and the split simply never exists. So this spec creates a NEW
 * context from the surface profile's Playwright descriptor and asserts the
 * viewport it actually got (viewportMatchesSurface) before touching the DOM,
 * exactly like vibe-color-loop.spec.ts does for mobile.
 *
 * The verdicts are STRUCTURAL (lane switcher / pane labels / peek tab), not
 * pixel reads: the split's existence is a layout fact, and there is no dev
 * server behind it in headless CI. The pixel loop already proves the preview
 * lanes themselves in vibe-color-loop.spec.ts.
 *
 * Skipped rather than failed without MOBILE_WEB_URL, matching the mobile arc:
 * an environment gap is not a product defect.
 */

const MOBILE_WEB_URL = process.env.MOBILE_WEB_URL || "";
const MOBILE_LANDSCAPE = profileFor("tabletLandscape");
const MOBILE_PORTRAIT = profileFor("tablet");

test("tablet vibe studio renders the landscape split", async ({ browser }) => {
  test.skip(!MOBILE_WEB_URL, "MOBILE_WEB_URL is unset — the RN-web app is not served");

  // NEW context from the surface profile's device descriptor. Never
  // page.setViewportSize() on a desktop context: isMobile/hasTouch/UA are
  // context properties and the RN-web tree branches on them.
  const context = await browser.newContext({ ...devices[MOBILE_LANDSCAPE.playwrightDevice!] });
  const page = await context.newPage();

  // VIEWPORT FIRST — the device-context guard.
  const vp = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    hasTouch: "ontouchstart" in window || navigator.maxTouchPoints > 0,
    isMobile: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent),
  }));
  const vpCheck = viewportMatchesSurface("tabletLandscape", vp);
  expect(vpCheck.ok,
    `tabletLandscape viewport: ${vpCheck.reason} (saw ${vp.width}x${vp.height}, touch=${vp.hasTouch}, mobileUA=${vp.isMobile})`)
    .toBe(true);

  await page.goto(`${MOBILE_WEB_URL.replace(/\/$/, "")}/vibe-studio`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(12_000);

  // The studio screen rendered (its own header).
  await expect(page.getByText(/^Vibe Studio$/).first(), "tablet: /vibe-studio did not render")
    .toBeVisible({ timeout: 30_000 });

  // LANDSCAPE SPLIT — the lane switcher is the landscape-only control.
  await expect(page.getByText(/^Browser$/).first(), "tabletLandscape: lane switcher (Browser) missing")
    .toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/^Live$/).first(), "tabletLandscape: lane switcher (Live) missing")
    .toBeVisible({ timeout: 15_000 });

  // CHAT PANE — the right-side composer is the chat pane's marker.
  await expect(
    page.getByPlaceholder(/^Vibe — what should we change\?$|^Connect a box first$|^What should we change\?$/i).first(),
    "tabletLandscape: chat composer missing in the right pane",
  ).toBeVisible({ timeout: 15_000 });

  await context.close();
});

test("tablet vibe studio shows portrait peek without the split", async ({ browser }) => {
  test.skip(!MOBILE_WEB_URL, "MOBILE_WEB_URL is unset — the RN-web app is not served");

  const context = await browser.newContext({ ...devices[MOBILE_PORTRAIT.playwrightDevice!] });
  const page = await context.newPage();

  const vp = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    hasTouch: "ontouchstart" in window || navigator.maxTouchPoints > 0,
    isMobile: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent),
  }));
  const vpCheck = viewportMatchesSurface("tablet", vp);
  expect(vpCheck.ok,
    `tablet viewport: ${vpCheck.reason} (saw ${vp.width}x${vp.height}, touch=${vp.hasTouch}, mobileUA=${vp.isMobile})`)
    .toBe(true);

  await page.goto(`${MOBILE_WEB_URL.replace(/\/$/, "")}/vibe-studio`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(12_000);

  await expect(page.getByText(/^Vibe Studio$/).first(), "tablet(portrait): /vibe-studio did not render")
    .toBeVisible({ timeout: 30_000 });

  // PORTRAIT — no landscape split: the lane switcher must NOT exist.
  await expect(page.getByText(/^Browser$/).first(), "tablet(portrait): lane switcher must not exist").toHaveCount(0);

  // The peek tab is the portrait-only affordance.
  await expect(page.getByText(/^Preview$/).first(), "tablet(portrait): preview peek tab missing")
    .toBeVisible({ timeout: 15_000 });

  await context.close();
});
