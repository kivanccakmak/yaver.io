import { devices, expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { profileFor, viewportMatchesSurface } from "../../web/lib/surfaceViewports";

const agent = (process.env.E2E_AGENT_URL || "http://127.0.0.1:18080").replace(/\/$/, "");
const projectPath = (process.env.YAVER_DOGFOOD_PROJECT_PATH || "").trim();
const token = process.env.YAVER_TEST_TOKEN || tokenFromLocalConfig();

function tokenFromLocalConfig(): string {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".yaver", "config.json"), "utf8"));
    return typeof config.auth_token === "string" ? config.auth_token : "";
  } catch {
    return "";
  }
}

test("Yaver browser Dogfood reaches the live dev server for fast and full reload", async ({ browser, request }) => {
  test.skip(!token || !projectPath, "needs YAVER_TEST_TOKEN + YAVER_DOGFOOD_PROJECT_PATH");

  const profile = profileFor("mobile");
  const descriptor = devices[profile.playwrightDevice!];
  const context = await browser.newContext({
    ...descriptor,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  const page = await context.newPage();

  try {
    const viewport = page.viewportSize()!;
    const verdict = viewportMatchesSurface("mobile", {
      ...viewport,
      isMobile: descriptor.isMobile,
      hasTouch: descriptor.hasTouch,
    }, 0);
    expect(verdict.ok, verdict.reason).toBe(true);

    const response = await page.goto(`${agent}/dev/`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
    expect(response?.status(), "authenticated Yaver browser document status").toBe(200);
    await expect(page).toHaveTitle(/Yaver/i);
    await expect(page.locator("#root")).not.toBeEmpty({ timeout: 120_000 });

    for (const mode of ["fast", "full"] as const) {
      const reload = await request.post(`${agent}/dogfood/reload`, {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          lane: "browser",
          mode,
          projectPath,
          projectName: "yaver-mobile",
          source: "ubuntu-browser-e2e",
        },
      });
      const payload = await reload.json().catch(() => ({}));
      expect(reload.ok(), `${mode} reload failed: ${JSON.stringify(payload).slice(0, 500)}`).toBe(true);
      expect(payload).toMatchObject({
        ok: true,
        reloadTarget: "browser-dev-server",
        transport: "browser-dev-server",
      });
      await expect(page).toHaveTitle(/Yaver/i);
      await expect(page.locator("#root")).not.toBeEmpty();
    }
  } finally {
    await context.close();
  }
});
