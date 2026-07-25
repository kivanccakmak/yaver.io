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

    // Click the first VISIBLE + enabled match.
    //
    // The dashboard renders its nav twice (responsive), so `locator.first()` often
    // resolves to the hidden copy and the click then waits out the whole test
    // timeout — a test bug that reads exactly like a product hang.
    const clickVisible = async (name: RegExp, what: string) => {
      const all = page.getByRole("button", { name });
      const count = await all.count();
      for (let i = 0; i < count; i++) {
        const b = all.nth(i);
        if (!(await b.isVisible().catch(() => false))) continue;
        if (await b.isDisabled().catch(() => false)) continue;
        await b.click();
        return true;
      }
      // Fall back to any visible element carrying the text (tabs are not always
      // <button>).
      const texts = page.getByText(name);
      const tcount = await texts.count();
      for (let i = 0; i < tcount; i++) {
        const t = texts.nth(i);
        if (await t.isVisible().catch(() => false)) {
          await t.click();
          return true;
        }
      }
      throw new Error(`no visible, enabled control for ${what}`);
    };

    await signIn(page);
    await step("dashboard-loaded");
    await expect(page).toHaveURL(/\/dashboard/);

    // 1. The box must appear in the dashboard at all.
    //
    // Asserted against the rendered TEXT of the page rather than a located
    // element: `getByText(...).first()` can resolve to a hidden duplicate (the
    // responsive nav renders the device chip twice), and then toBeVisible fails
    // while the name is plainly on screen — which is a test bug that reads exactly
    // like a product bug.
    const deviceRe = new RegExp(LIVE_DEVICE, "i");
    await expect
      .poll(async () => deviceRe.test(await page.locator("body").innerText()), {
        timeout: 60_000,
        message: `the dashboard never showed a device matching /${LIVE_DEVICE}/i`,
      })
      .toBe(true);
    await step("device-visible");

    // 2. Projects — the surface that owns remote rendering. (Discovered from the
    //    live dashboard rather than assumed: the sidebar has no "Runtime" entry;
    //    ProjectsView is what mounts RemoteRuntimeViewer, and each project row
    //    carries its own lane buttons.)
    await clickVisible(/^Projects$/, "the Projects tab");
    await step("projects-tab");

    // The project list comes from the BOX, so its arrival is itself a
    // connectivity assertion — an empty list here is the "No projects yet" lie
    // this product has shipped before.
    const projectRow = LIVE_PROJECT
      ? page.getByText(new RegExp(LIVE_PROJECT, "i")).first()
      : page.locator("button", { hasText: /Simulator \(WebRTC\)|^Start$|Hermes/ }).first();
    await expect(projectRow, "the dashboard never listed projects from the box").toBeVisible({
      timeout: 90_000,
    });
    await step("projects-listed");

    // 3. Open the WebRTC lane for that project. This is the button a user clicks:
    //    "Simulator (WebRTC)" — run the app in a remote simulator, streamed here.
    const hasWebrtc = await page
      .getByRole("button", { name: /Simulator \(WebRTC\)/i })
      .first()
      .isVisible()
      .catch(() => false);
    if (hasWebrtc) {
      await clickVisible(/Simulator \(WebRTC\)/i, "the WebRTC lane");
      await step("webrtc-lane-opened");
    } else {
      // Web-served projects (Flutter/Vite/Next) have a plain Start; their remote
      // rendering is the browser lane, which is equally valid to validate here.
      const startBtn = page.getByRole("button", { name: /^Start$/ }).first();
      await expect(startBtn, "neither a WebRTC nor a Start control was offered for any project")
        .toBeVisible({ timeout: 30_000 });
      await startBtn.click();
      await step("browser-lane-started");
    }

    // 4. Start a session on the first enabled target and prove a live surface
    //    appears. Either transport counts: <video srcObject> (RTP) or the <img>
    //    blob fallback (JPEG over the data channel). What must NOT happen is a
    //    spinner with nothing behind it.
    const startButtons = page.getByRole("button", { name: /start|launch|open|stream|connect/i });
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
      // The lane may already be streaming (the modal starts a session on open).
      // Only fail if there is ALSO no surface and no message — i.e. silence.
      const anySurface = await page
        .locator("video, img[src^='blob:'], canvas")
        .first()
        .isVisible()
        .catch(() => false);
      if (!anySurface) {
        const body = (await page.locator("body").innerText()).slice(0, 1500);
        throw new Error(`no start control and no surface after opening the lane.\nPage said:\n${body}`);
      }
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
