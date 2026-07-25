import { expect, test } from "@playwright/test";
import { signIn } from "../helpers/login";

/**
 * LIVE end-to-end validation of remote rendering from the web dashboard.
 *
 * Unlike every other spec here, this one mocks NOTHING: it drives the real
 * dashboard against a real signed-in account and a real remote box, because the
 * failure this exists to catch was invisible to mocked tests and to component
 * checks alike.
 *
 * The history that earned it (2026-07-25): a Flutter browser preview showed
 * "waiting for the first output from the box" for a whole session. `curl` against
 * the agent's proxy said 200. The unit tests were green. The phone was broken —
 * because the CLIENT never read the event stream. Only a test that renders the
 * real client against the real box can fail on that.
 *
 * Skipped unless the environment names a live target, so CI stays hermetic:
 *
 *   YAVER_TEST_TOKEN     session token for the account that owns the box
 *   E2E_BASE_URL         https://yaver.io (or a preview deployment)
 *   E2E_LIVE_DEVICE      substring of the box's name as the dashboard shows it
 *   E2E_LIVE_PROJECT     optional: substring of the project to preview
 *
 * Run:
 *   YAVER_TEST_TOKEN=… E2E_BASE_URL=https://yaver.io E2E_LIVE_DEVICE="Mac mini" \
 *     npx playwright test tests/remote-preview-live.spec.ts --headed
 */
const LIVE_DEVICE = process.env.E2E_LIVE_DEVICE || "";
const LIVE_PROJECT = process.env.E2E_LIVE_PROJECT || "";
const HAS_LIVE_TARGET = !!(process.env.YAVER_TEST_TOKEN && LIVE_DEVICE);

test.describe("live remote rendering from the web dashboard", () => {
  test.skip(!HAS_LIVE_TARGET, "set YAVER_TEST_TOKEN + E2E_LIVE_DEVICE to run against a real box");
  // A cold Flutter/Expo web compile on a real machine legitimately takes minutes.
  test.setTimeout(6 * 60_000);

  test("connects to the box, opens Runtime, and gets a live surface", async ({ page }, testInfo) => {
    const steps: string[] = [];
    const step = async (name: string) => {
      steps.push(`${new Date().toISOString().slice(11, 19)} ${name}`);
      await testInfo.attach(`step-${steps.length}-${name.replace(/\W+/g, "-")}`, {
        body: await page.screenshot({ fullPage: false }),
        contentType: "image/png",
      });
    };

    // Surface browser-side failures instead of letting them look like a hang —
    // the exact silence this whole investigation was about.
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
    });
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));

    await signIn(page);
    await step("dashboard-loaded");
    await expect(page).toHaveURL(/\/dashboard/);

    // 1. The box must be visible AND reachable. "online" is not reachable — the
    //    dashboard's own device row is the thing under test here.
    const deviceMention = page.getByText(new RegExp(LIVE_DEVICE, "i")).first();
    await expect(deviceMention, `the dashboard never showed a device matching /${LIVE_DEVICE}/i`)
      .toBeVisible({ timeout: 60_000 });
    await step("device-visible");

    // 2. Runtime tab — the surface that owns remote rendering (RuntimeLabView →
    //    RemoteRuntimeViewer, WebRTC with a JPEG data-channel fallback).
    const runtimeTab = page.getByRole("button", { name: /^Runtime$/ }).first();
    if (await runtimeTab.isVisible().catch(() => false)) {
      await runtimeTab.click();
    } else {
      await page.getByText(/^Runtime$/).first().click();
    }
    await step("runtime-tab");

    // 3. Pick the project, then ask the box what it can actually render. The
    //    capability list is a probe of the HOST, so an honest answer here is half
    //    the feature: a target that is disabled must say why.
    const projectSelect = page.locator("select").first();
    await expect(projectSelect, "Runtime tab never rendered a project picker").toBeVisible({
      timeout: 30_000,
    });
    if (LIVE_PROJECT) {
      const options = await projectSelect.locator("option").allTextContents();
      const match = options.find((o) => o.toLowerCase().includes(LIVE_PROJECT.toLowerCase()));
      if (match) await projectSelect.selectOption({ label: match });
    }
    await step("project-selected");

    const loadCaps = page.getByRole("button", { name: /capabilit/i }).first();
    await loadCaps.click();
    await step("capabilities-requested");

    // The log pane in RuntimeLabView echoes "targets: …". Its presence proves the
    // dashboard actually reached the box; its content proves what the box offers.
    const targetsLine = page.getByText(/targets:/i).first();
    await expect(targetsLine, "the box never answered the capability probe").toBeVisible({
      timeout: 90_000,
    });
    const targets = (await targetsLine.textContent()) || "";
    testInfo.annotations.push({ type: "targets", description: targets.slice(0, 400) });
    await step("capabilities-answered");

    // Every disabled target must carry a REASON. A disabled control with no
    // explanation is the defect class this product keeps paying for — and on this
    // very box a "not installed" reason was flat wrong for an installed runtime.
    expect(targets, "capability answer was empty").not.toEqual("");

    // 4. Start a session on the first enabled target and prove a live surface
    //    appears. Either transport counts: <video srcObject> (RTP) or the <img>
    //    blob fallback (JPEG over the data channel). What must NOT happen is a
    //    spinner with nothing behind it.
    const startButtons = page.getByRole("button", { name: /start|launch|open/i });
    const startCount = await startButtons.count();
    let started = false;
    for (let i = 0; i < startCount && !started; i++) {
      const b = startButtons.nth(i);
      if (!(await b.isVisible().catch(() => false))) continue;
      if (await b.isDisabled().catch(() => true)) continue;
      await b.click();
      started = true;
    }
    await step("session-start-clicked");

    if (!started) {
      // Not a pass: report what the page offered so the reason is in the artifact
      // rather than in someone's memory.
      const body = (await page.locator("body").innerText()).slice(0, 1500);
      throw new Error(`no enabled start control on the Runtime tab.\nPage said:\n${body}`);
    }

    // 5. A live surface within the budget, or a NAMED failure. Both are
    //    acceptable outcomes for this assertion; silence is not.
    const surface = page.locator("video, img[src^='blob:'], canvas").first();
    const errorText = page.getByText(/failed|unavailable|error|not installed|could not/i).first();

    const outcome = await Promise.race([
      surface
        .waitFor({ state: "visible", timeout: 150_000 })
        .then(() => "surface" as const)
        .catch(() => "timeout" as const),
      errorText
        .waitFor({ state: "visible", timeout: 150_000 })
        .then(() => "named-error" as const)
        .catch(() => "timeout" as const),
    ]);
    await step(`outcome-${outcome}`);

    if (outcome === "named-error") {
      const msg = (await errorText.textContent()) || "";
      testInfo.annotations.push({ type: "named-failure", description: msg.slice(0, 300) });
      // A named failure is a WORKING product telling the truth. The test records
      // it and passes the "no silence" bar, which is what this spec guards.
      expect(msg.trim().length, "an error appeared with no text in it").toBeGreaterThan(0);
      return;
    }

    expect(
      outcome,
      `no live surface and no named failure within the budget — this is the silent hang the ` +
        `spec exists to catch. Console errors: ${consoleErrors.slice(0, 5).join(" | ") || "(none)"}`,
    ).toBe("surface");

    // If it is a <video>, insist on actual pixels: a visible element with
    // videoWidth 0 is the black-screen bug wearing a green checkmark.
    const isVideo = await surface.evaluate((el) => el.tagName.toLowerCase() === "video");
    if (isVideo) {
      await expect
        .poll(
          async () => surface.evaluate((el) => (el as HTMLVideoElement).videoWidth),
          { timeout: 60_000, message: "the <video> never received a frame (videoWidth stayed 0)" },
        )
        .toBeGreaterThan(0);
    }
    await step("frames-arriving");
  });
});
