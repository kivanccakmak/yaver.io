/**
 * sfmg-preview-narration.spec.ts — the REAL Yaver mobile app, in a true iPhone
 * device context, previewing sfmg served by a REAL remote box.
 *
 * ── What this arc exists to prove ──────────────────────────────────────────
 *
 * TestFlight build 500, 2026-08-03. The user opened `sfmg` on a real iPhone
 * against a remote box and got a SOLID BLACK RECTANGLE for two minutes: no
 * text, no elapsed time, no name of what was running. Then, at 18:23, the app
 * appeared and worked perfectly.
 *
 * Nothing was broken. The box was healthy and printing progress the whole time
 * — "Starting Metro Bundler", "Web Bundled 4844ms … (2186 modules)", "ready
 * 100%" — into a log panel one tap away. The preview surface's ENTIRE
 * "we're working on it" affordance was a 3px progress bar.
 *
 * The user's verdict, verbatim: "the ux ui plumbing is not good, user wont
 * feel that its going well at some stages."
 *
 * No existing arc could catch that, because every arc asked "did the pixels
 * eventually become right?" — and they DID. The defect lives entirely in the
 * interval before that, which nothing was watching. So this arc asserts on the
 * WAIT, not on the destination:
 *
 *   1. While the preview is blank, the surface SAYS something.
 *   2. What it says includes elapsed time and last-progress — the heartbeat
 *      CLAUDE.md requires of every wait the product imposes.
 *   3. The moment content paints, that panel is GONE (a status card over a
 *      working app is the surprise-re-render defect wearing a helpful face).
 *
 * ── Why RN-web and not a native simulator build ────────────────────────────
 *
 * Per CLAUDE.md, driving the mobile app as RN-web at a true device context is
 * "the only way to automate the REAL app instead of the web dashboard". The
 * code under test — previewWaitLine and its panel — is platform-agnostic React
 * and runs identically on both. A native build proves the same logic at ~30
 * minutes' cost; this proves it in seconds, so this runs first and always.
 *
 * ── MOBILE IS A DEVICE CONTEXT, NEVER A RESIZED DESKTOP ONE ────────────────
 *
 * A new context with the full device descriptor, and the viewport is ASSERTED.
 * `page.setViewportSize()` cannot change isMobile/hasTouch/deviceScaleFactor —
 * those are CONTEXT properties — so a shrunk desktop context is a narrow
 * desktop browser, and RN-web renders a different component tree for it. A
 * green result there would say nothing about the app the user holds.
 */
import { test, expect, devices, type Response } from "@playwright/test";
import { profileFor, viewportMatchesSurface } from "../../web/lib/surfaceViewports";
// Shared with the browser coordinator: do not bypass system-Chromium fallback
// by calling Playwright's managed headless shell directly.
import { launchChromium } from "../browser-automation/chromium-executable.mjs";

const MOBILE_WEB_URL = process.env.MOBILE_WEB_URL || "";
const BOX = process.env.VIBE_BOX_HOST || "";
const TOKEN = process.env.YAVER_TEST_TOKEN || "";
const PROJECT = process.env.VIBE_PROJECT_NAME || "sfmg";

test.describe("sfmg preview narrates its wait", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!MOBILE_WEB_URL, "set MOBILE_WEB_URL (cd mobile && npx expo start --web --port 8099)");
  test.skip(!BOX, "set VIBE_BOX_HOST (e.g. http://<your-box>:18080)");
  test.skip(!TOKEN, "set YAVER_TEST_TOKEN (a session token for the box's owner)");

  for (const surface of ["mobile", "tablet"] as const) {
  test(`${surface}: a blank preview says what is running, for how long, and when it last moved`, async () => {
    const browser = await launchChromium();
    // The device descriptor, whole. Not a viewport.
    const profile = profileFor(surface);
    const descriptorName = surface === "mobile" ? "iPhone 15 Pro" : profile.playwrightDevice!;
    const ctx = await browser.newContext({ ...devices[descriptorName] });
    const page = await ctx.newPage();
    let browserLaneAssetFailure = "";
    page.on("response", (response: Response) => {
      const url = response.url();
      // Expo may use the main /dev/ lane (platform:web) or the /dev-web/
      // sibling beside native Metro. Both are browser lanes and both must
      // serve JavaScript rather than an auth/error HTML document.
      if (!/\/dev(?:-web)?\//.test(url) || !/entry\.bundle(?:\?|$)/.test(url)) return;
      const contentType = String(response.headers()["content-type"] || "").toLowerCase();
      if (response.status() >= 400) {
        browserLaneAssetFailure = `browser entry bundle returned HTTP ${response.status()}`;
      } else if (contentType.includes("text/html")) {
        // Never include the URL: the scoped lane may carry an auth query.
        browserLaneAssetFailure = "browser entry bundle returned HTML instead of JavaScript";
      }
    });

    try {
      // Seed the session the way the app itself stores it. The RN app writes
      // through secureStoreCompat, which on web is localStorage under the
      // `yaver.secure.` prefix — NOT the web dashboard's bare key. Getting this
      // wrong signs you into a different surface and tests nothing.
      await page.goto(MOBILE_WEB_URL, { waitUntil: "domcontentloaded" });

      // ASSERT THE CONTEXT WE ACTUALLY GOT. A context that silently came back
      // desktop-shaped must fail loudly here rather than pass quietly three
      // assertions later.
      //
      // MEASURED AFTER NAVIGATION, DELIBERATELY. The first version of this
      // check ran on about:blank and read innerWidth 980 on a perfectly good
      // iPhone context — with no <meta name="viewport">, mobile emulation
      // reports the 980px fallback LAYOUT viewport, not the device. It failed a
      // healthy harness, which is the same false signal in the other
      // direction. `screen.width`, `hasTouch` and `deviceScaleFactor` are
      // device-level and true even on a blank page; innerWidth is only
      // meaningful once a page that declares a viewport has loaded.
      const shape = await page.evaluate(() => ({
        w: window.innerWidth,
        h: window.innerHeight,
        screenW: window.screen.width,
        screenH: window.screen.height,
        touch: "ontouchstart" in window || navigator.maxTouchPoints > 0,
        mobile: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent),
        dpr: window.devicePixelRatio,
      }));
      const contextViewport = page.viewportSize();
      const viewportMatch = viewportMatchesSurface(surface, {
        // Validate the context Playwright created, not the document's layout
        // viewport (Expo can report 446px) or the physical screen (852px tall).
        // The shared profile intentionally describes the visible browser
        // viewport, 393x659, while touch/UA/DPR below prove device emulation.
        width: contextViewport?.width ?? 0,
        height: contextViewport?.height ?? 0,
        hasTouch: shape.touch,
        isMobile: shape.mobile,
      });
      expect(viewportMatch.ok, viewportMatch.reason).toBe(true);
      expect(shape.touch, "hasTouch — a context property setViewportSize cannot fake").toBe(true);
      expect(shape.dpr, "deviceScaleFactor").toBeGreaterThan(1);
      // innerWidth is NOT asserted, on purpose.
      //
      // It read 446 here against a genuine iPhone 15 Pro context whose
      // screen.width, hasTouch and deviceScaleFactor were all correct — the
      // number is Expo's web template layout viewport, not the device. And it
      // is exactly the layout-level measurement CLAUDE.md says is not the
      // guarantee: "isMobile, hasTouch, deviceScaleFactor are CONTEXT
      // properties that page.setViewportSize() cannot change". Those three are
      // asserted above and are what decide which component tree RN-web renders.
      // Pinning innerWidth would fail honest runs whenever the web template's
      // meta tag changes, which is a false red for a harness detail.
      void shape.w;
      await page.evaluate((t: string) => {
        // THE INSTALL FLAG MUST GO IN WITH THE TOKEN.
        //
        // auth.ts::clearKeychainIfFreshInstall exists because iOS Keychain data
        // survives an app uninstall while AsyncStorage does not — so a missing
        // `yaver_installed` flag means "fresh install", and the app wipes any
        // leftover token. Correct on a real phone. But a fresh BROWSER PROFILE
        // looks exactly like a fresh install, so seeding only the token gets it
        // deleted on the next boot and the arc lands on the sign-in screen.
        //
        // Cost of not knowing this: a full debugging pass that concluded "the
        // token was rejected by Convex". It was not — it was never validated,
        // it was erased. Seed both, and the app comes up signed in.
        localStorage.setItem("yaver_installed", "1");
        localStorage.setItem("yaver.secure.yaver_auth_token", t);
      }, TOKEN);
      // Boot directly on the surface under test. Reloading `/`, waiting for a
      // connection, and then doing a second full document navigation to
      // `/apps` destroys the first transport ladder midway through hydration.
      // The replacement client can then paint an empty inventory while it is
      // still reconnecting — a harness-induced false RED that no real tab tap
      // performs. One authenticated document, one transport lifecycle.
      await page.goto(`${MOBILE_WEB_URL.replace(/\/$/, "")}/apps`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(18_000);

      const body = (await page.locator("body").innerText().catch(() => "")) || "";
      test.skip(
        /continue with apple|continue with google|sign in with/i.test(body),
        "the app is signed out — the seeded token did not take, so no preview can exist",
      );

      // OPEN THE PREVIEW — by its ACTION, not by the project's name.
      //
      // Matching the project name first landed on the Tasks tab: the running
      // dev server has a status card there that also says "sfmg", so the name
      // is ambiguous across screens and tapping the wrong one navigates
      // nowhere. The arc then asserted "the surface said nothing" about a
      // surface that was never the preview — a false RED, which is the same
      // class of lie as a false green.
      //
      // "Open in Yaver" is the action that opens the preview, it appears only
      // where a preview can be opened, and it is what a user taps. Assert on
      // the verb, not the noun.
      const escapedProject = PROJECT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const openBtn = page
        .getByRole("button", { name: new RegExp(`Open .*${escapedProject}.* in Yaver`, "i") })
        .first();
      if (await openBtn.isVisible({ timeout: 15_000 }).catch(() => false)) {
        await openBtn.click();
      } else {
        // No running preview to open — go through Projects instead.
        // Project discovery labels repository roots as `root (<name>)`, so an
        // exact `<name>` matcher is stale even though the correct row is on
        // screen. Keep this fallback strict while accepting that canonical
        // wrapper; the preferred action above remains unambiguous.
        const sfmgCard = page.getByText(new RegExp(`^(?:root \\()?${escapedProject}\\)?$`, "i")).last();
        await expect(sfmgCard, `${PROJECT} is visible somewhere in the app`).toBeVisible({ timeout: 30_000 });
        await sfmgCard.click();
        // When this project already owns the active dev-server slot, tapping
        // its row opens the preview directly. Otherwise it opens the action
        // sheet and Browser Reload is the required lane.
        let reachedPreview = false;
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const browserLane = page.getByText(/browser reload/i).first();
          if (await browserLane.isVisible().catch(() => false)) {
            await browserLane.click();
            reachedPreview = true;
            break;
          }
          const narrated = await page
            .getByText(/server ready — loading page|elapsed.*last output/i)
            .first()
            .isVisible()
            .catch(() => false);
          const hasControls = await page.locator('[aria-label="Stop dev server"]').first().isVisible().catch(() => false);
          const hasFrame = (await page.locator("iframe").count()) > 0;
          if (narrated || hasControls || hasFrame) {
            reachedPreview = true;
            break;
          }
          await page.waitForTimeout(1_000);
        }
        expect(reachedPreview, "SFMG row must open Browser Reload or the active browser preview").toBe(true);
      }

      // ── AN ARC MUST NOT ACCUSE THE PRODUCT OF SOMETHING IT DID NOT SEE ──
      //
      // The run before this one failed with "the surface said NOTHING — this is
      // the build-500 defect" while the app was still sitting on the TASKS tab.
      // The preview had never opened. The verdict was confident, specific, and
      // about a screen the arc was not looking at.
      //
      // That is the same defect this whole suite exists to remove, committed by
      // the suite: a signal asserted without the operation being attempted. A
      // false RED trains readers to distrust the arc exactly as fast as a false
      // green does.
      //
      // So: prove we are on the preview, by a marker that exists ONLY there,
      // and if we are not, SKIP with a named cause. "I could not open the
      // preview" is a true statement. "The preview was silent" would not be.
      const onPreview = await page
          .locator('[aria-label="Stop dev server"]')
          .isVisible({ timeout: 20_000 })
          .catch(() => false);
      const hasPreviewNarration = await page
        .getByText(/server ready — loading page|elapsed · last output/i)
        .first()
        .isVisible({ timeout: 2_000 })
        .catch(() => false);
      // POSITIVE PROOF REQUIRED. The earlier form skipped only when it could
      // ALSO recognise the Tasks tab — so an unrecognised third screen still
      // reached the assertion and got graded as the preview. Absence of proof
      // that we are on the preview is itself the reason to stop.
      expect(
        onPreview || hasPreviewNarration,
        `Browser Reload did not open the preview surface. Visible client text:\n${((await page.locator("body").innerText().catch(() => "")) || "").slice(0, 1400)}`,
      ).toBe(true);

      // ── THE ASSERTION THIS FILE EXISTS FOR ─────────────────────────────
      //
      // Poll the surface while the preview is still blank. At EVERY sample the
      // app must be saying something specific. The old build said nothing at
      // all here, for two minutes.
      const deadline = Date.now() + 90_000;
      let narrated = false;
      let sawElapsed = false;
      let lastSeen = "";
      while (Date.now() < deadline) {
        const text = (await page.locator("body").innerText().catch(() => "")) || "";
        lastSeen = text;
        // "1:24 elapsed", "40s elapsed" — the heartbeat, in the shape
        // previewWait.ts emits and previewWait.test.mts pins.
        if (/\d+(:\d\d)?s? elapsed/i.test(text)) { narrated = true; sawElapsed = true; }
        if (/last output .* ago|no output yet/i.test(text)) narrated = true;
        // Stop early once the app has painted — the wait is over and there is
        // nothing left to observe about it.
        if (/dil seçimi|language|devam et/i.test(text)) break;
        if (narrated) break;
        await page.waitForTimeout(2_000);
      }

      expect(
        narrated,
        "while the preview was blank the surface said NOTHING — this is the build-500 defect:\n" +
          lastSeen.slice(0, 600),
      ).toBe(true);
      expect(sawElapsed, "the narration includes elapsed time, not just a spinner").toBe(true);

      // Fail on the named transport operation immediately. Waiting two minutes
      // for an empty #root after Metro's script request already returned HTML
      // only hides the cause and makes the loop needlessly expensive.
      await page.waitForTimeout(1_000);
      expect(browserLaneAssetFailure, "the scoped browser lane must serve its entry bundle as JavaScript").toBe("");

      // ── AND IT MUST GET OUT OF THE WAY ────────────────────────────────
      // Once content paints, the panel is gone. A status card over a working
      // app is the same defect as a placeholder replacing a good preview.
      await expect.poll(async () => {
        // Playwright can inspect the cross-origin frame through CDP even though
        // the RN-web parent cannot inject its ready probe. This is the actual
        // operation: real guest DOM in the frame, not the box-side doctor's
        // separate browser saying it rendered somewhere else.
        const iframe = page.locator('iframe[title="preview"]').first();
        const handle = await iframe.elementHandle().catch(() => null);
        const frame = await handle?.contentFrame();
        if (!frame) return false;
        // sfmg is an Expo SPA: a response body, title, or error document is not
        // paint. The exact incident served HTML where JavaScript was expected,
        // so accepting arbitrary body text made this assertion green while the
        // visible frame remained black.
        return (await frame.locator("#root > *").count().catch(() => 0)) > 0;
      }, {
        timeout: 120_000,
        message:
          "Open in Yaver never painted guest content in the phone frame. " +
          "A box-side doctor=rendered verdict cannot satisfy this assertion.",
      }).toBe(true);

      const after = (await page.locator("body").innerText().catch(() => "")) || "";
      expect(
        /\d+(:\d\d)?s? elapsed/i.test(after),
        "the wait panel is still covering a preview that has already painted",
      ).toBe(false);
    } finally {
      await ctx.close();
      await browser.close();
    }
  });
  }
});
