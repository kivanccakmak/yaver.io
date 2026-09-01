import { devices, expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { profileFor, viewportMatchesSurface } from "../../web/lib/surfaceViewports";

const mobileURL = (process.env.MOBILE_WEB_URL || "").replace(/\/$/, "");
const token = process.env.YAVER_TEST_TOKEN || tokenFromLocalConfig();
const convexSite = process.env.E2E_CONVEX_URL ||
  process.env.NEXT_PUBLIC_CONVEX_SITE_URL ||
  "https://perceptive-minnow-557.eu-west-1.convex.site";

function tokenFromLocalConfig(): string {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".yaver", "config.json"), "utf8"));
    return typeof config.auth_token === "string" ? config.auth_token : "";
  } catch {
    return "";
  }
}

test("RN-web shows only Remote box, Runner, and Checkout until one is opened", async ({ browser }) => {
  test.skip(!mobileURL || !token, "needs MOBILE_WEB_URL + YAVER_TEST_TOKEN");

  // A viewport resize is not a mobile device. Own a genuine touch/mobile/UA
  // context so RN-web renders the same component tree a phone receives.
  const profile = profileFor("mobile");
  const context = await browser.newContext({
    ...devices[profile.playwrightDevice!],
    storageState: undefined,
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (
      message.type() === "error" ||
      message.type() === "warning" ||
      /\[(?:DeviceContext|QUIC)\]/.test(message.text())
    ) {
      console.log(`[rn-web:${message.type()}] ${message.text()}`);
    }
  });
  page.on("requestfailed", (request) => {
    console.log(`[rn-web:requestfailed] ${request.method()} ${request.url()} · ${request.failure()?.errorText || "unknown"}`);
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    console.log(`[rn-web:http] ${response.status()} ${response.request().method()} ${url.origin}${url.pathname}`);
  });
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
    await expect(page.getByRole("button", { name: "Open Dogfood settings" })).toBeVisible({ timeout: 120_000 });
    await page.getByRole("button", { name: "Open Dogfood settings" }).click();
    await expect(page.getByText("Dogfood Settings").first()).toBeVisible({ timeout: 120_000 });
    const viewport = page.viewportSize()!;
    const contextSignals = await page.evaluate(() => ({
      isMobile: /Mobile|iPhone|Android/i.test(navigator.userAgent),
      hasTouch: navigator.maxTouchPoints > 0,
    }));
    const viewportVerdict = viewportMatchesSurface("mobile", { ...viewport, ...contextSignals });
    expect(viewportVerdict.ok, viewportVerdict.reason).toBe(true);

    await expect(page.getByText("Remote box", { exact: true })).toBeVisible();
    await expect(page.getByText("Runner", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Checkout", { exact: true })).toBeVisible();
    await expect(page.getByText("Developer management", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Box choices")).toHaveCount(0);
    await expect(page.getByLabel("Runner choices")).toHaveCount(0);
    await expect(page.getByLabel("Yaver checkout choices")).toHaveCount(0);
    await expect(page.getByText("Runtime", { exact: true })).toHaveCount(0);

    const runnerControl = page.getByRole("button", { name: /^(?:Change|Set up) Runner$/ });
    await runnerControl.scrollIntoViewIfNeeded();
    await expect(runnerControl).toBeInViewport();
    await runnerControl.click();
    await expect(page.getByLabel("Runner choices")).toBeVisible();
    await expect(page.getByText("Runtime", { exact: true })).toBeVisible();
    await expect(page.getByText(/Browser lane/).first()).toBeVisible();
    await expect(page.getByText("Hermes", { exact: true })).toBeVisible();
    await expect(page.getByText(/WebRTC native/).first()).toBeVisible();
  } finally {
    await context.close();
  }
});
