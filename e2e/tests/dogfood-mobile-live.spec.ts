import { devices, expect, test } from "@playwright/test";
import { profileFor, viewportMatchesSurface } from "../../web/lib/surfaceViewports";

const mobileURL = (process.env.MOBILE_WEB_URL || "").replace(/\/$/, "");
const token = process.env.YAVER_TEST_TOKEN || "";
const convexSite = process.env.E2E_CONVEX_URL ||
  process.env.NEXT_PUBLIC_CONVEX_SITE_URL ||
  "https://perceptive-minnow-557.eu-west-1.convex.site";

test("RN-web keeps Dogfood choices collapsed until their summary row is changed", async ({ browser }) => {
  test.skip(!mobileURL || !token, "needs MOBILE_WEB_URL + YAVER_TEST_TOKEN");

  // A viewport resize is not a mobile device. Own a genuine touch/mobile/UA
  // context so RN-web renders the same component tree a phone receives.
  const profile = profileFor("mobile");
  const context = await browser.newContext({
    ...devices[profile.playwrightDevice!],
    storageState: undefined,
  });
  const page = await context.newPage();
  try {
    await page.goto(mobileURL, { waitUntil: "domcontentloaded", timeout: 120_000 });
    // Let the app finish its fresh-install check first. Seeding during that
    // check races clearKeychainIfFreshInstall(), which correctly deletes stale
    // credentials and leaves the harness on Login despite a valid token.
    await expect(page.getByText(/Continue with Email/i).first()).toBeVisible({ timeout: 120_000 });
    const auth = await page.request.get(`${convexSite}/auth/validate?_=${Date.now()}`, {
      headers: { Authorization: `Bearer ${token}`, "Cache-Control": "no-store" },
    });
    expect(auth.ok(), `auth validate returned HTTP ${auth.status()}`).toBe(true);
    const payload = await auth.json() as { user?: Record<string, unknown> };
    const user = payload.user || {};
    await page.evaluate(({ session, appUser }) => {
      localStorage.setItem("yaver.secure.yaver_auth_token", session);
      localStorage.setItem("yaver.secure.yaver_user", JSON.stringify(appUser));
    }, {
      session: token,
      appUser: {
        id: user.userId,
        email: user.email,
        name: user.fullName,
        provider: user.provider,
        emailVerified: user.emailVerified,
        surveyCompleted: user.surveyCompleted,
        isOwner: user.isOwner,
      },
    });

    await page.goto(`${mobileURL}/dogfood`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await expect(page.getByText("Develop Yaver").first()).toBeVisible({ timeout: 120_000 });
    const viewport = page.viewportSize()!;
    const contextSignals = await page.evaluate(() => ({
      isMobile: /Mobile|iPhone|Android/i.test(navigator.userAgent),
      hasTouch: navigator.maxTouchPoints > 0,
    }));
    const viewportVerdict = viewportMatchesSurface("mobile", { ...viewport, ...contextSignals });
    expect(viewportVerdict.ok, viewportVerdict.reason).toBe(true);

    await expect(page.getByText("Box", { exact: true })).toBeVisible();
    await expect(page.getByText("Runner", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Yaver checkout", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Box choices")).toHaveCount(0);
    await expect(page.getByLabel("Runner choices")).toHaveCount(0);
    await expect(page.getByLabel("Yaver checkout choices")).toHaveCount(0);
    await expect(page.getByText("Runtime", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: /(?:Change|Fix) Runner/ }).click();
    await expect(page.getByLabel("Runner choices")).toBeVisible();
    await expect(page.getByText("Runtime", { exact: true })).toBeVisible();
    await expect(page.getByText(/Browser lane/).first()).toBeVisible();
    await expect(page.getByText("Hermes", { exact: true })).toBeVisible();
    await expect(page.getByText(/WebRTC native/).first()).toBeVisible();
  } finally {
    await context.close();
  }
});
