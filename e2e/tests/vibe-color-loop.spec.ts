import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  classifyVibeColor,
  looksRendered,
  modalColor,
  samplePoints,
} from "../../web/lib/vibeVerdict";

/**
 * Vibe colour closed loop — black → RED → black — on BOTH driveable surfaces.
 *
 *   npx --prefix e2e playwright test vibe-color-loop.spec.ts
 *   (or via MCP: testkit_run {dir: "e2e", grep: "vibe colour"})
 *
 * ── What it proves ─────────────────────────────────────────────────────────
 *
 * The whole product in one arc: sign in, select the project on the box that
 * both RUNS and RENDERS, open the WEB-UI BROWSER LANE (explicitly not WebRTC),
 * change the login background by VIBING, and read the PIXELS back. Then revert,
 * as a separate task, and read them again.
 *
 * Two surfaces, one spec:
 *   • web      — the dashboard at the desktop viewport
 *   • mobile   — the YAVER MOBILE APP itself, served as RN-web so Chromium can
 *                drive it. That is the only honest way to automate the app the
 *                user actually holds (CLAUDE.md: browser transport contract).
 *                It needs MOBILE_WEB_URL and SKIPS without one — shrinking the
 *                dashboard viewport and calling it "mobile" would be a false
 *                equivalence, and they share neither transport ladder, auth
 *                storage key, nor render path.
 *
 * ── Why pixels, and only pixels ────────────────────────────────────────────
 *
 * A status badge has now been wrong in BOTH directions on this exact screen:
 * a run reported COMPLETED while the change was invisible (it landed in a
 * feature-gated component), and a run that had SUCCEEDED rendered as failed
 * because a sidecar logged 401 retries. So the terminal signal is the rendered
 * colour and nothing else.
 *
 * ── Why the sampling logic lives in web/lib ────────────────────────────────
 *
 * Because it was wrong, twice, in a way that made a WORKING product look
 * broken — a single band at 55% height ran through the sign-in buttons and read
 * a fully red screen as black, costing two twelve-minute runs and a bug hunt.
 * It is unit-tested in web/lib/vibeVerdict.test.ts and imported here, so the
 * decision that declares a pass can never again be an untested inline snippet.
 *
 * Skipped rather than failed without credentials: an environment gap is not a
 * product defect, and a suite that cries wolf on a fresh checkout gets ignored.
 */

const APP = process.env.WEB_URL || "https://yaver.io";
const BOX = process.env.VIBE_BOX || "ubuntu-4gb-hel1-1";
const PROJECT = process.env.VIBE_PROJECT || "yaver / mobile";
/** A runner turn + rebuild + reload. Generous: a loop that times out early
 *  reports failure for a system that was merely slow. */
const TURN_BUDGET_MS = Number(process.env.VIBE_BUDGET_MS || 12 * 60_000);

function creds() {
  return {
    email: process.env.YAVER_TEST_EMAIL || "",
    password: process.env.YAVER_TEST_PASSWORD || "",
  };
}

async function signInWithPassword(page: Page) {
  const { email, password } = creds();
  await page.goto(`${APP}/auth`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByPlaceholder("Email address").waitFor({ timeout: 20_000 });
  await page.getByPlaceholder("Email address").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(/\/(survey|dashboard)(?:$|\?)/, { timeout: 30_000 });
  if (page.url().includes("/survey")) await page.goto(`${APP}/dashboard`);
  await page.waitForTimeout(6000);
}

/** The target-card "Open" controls.
 *
 *  Deliberately NOT getByRole("button"): they are not <button> elements, so a
 *  role query matched zero and an earlier version of this loop reported "no
 *  render target offered" for a screen that plainly showed two. */
function openControls(page: Page): Locator {
  return page
    .locator('button, a, [role="button"], [class*="cursor-pointer"]')
    .filter({ hasText: /^Open$/ });
}

/**
 * Screenshot the preview iframe and return its modal colour.
 *
 * The preview is a cross-origin iframe (a relay URL), so canvas sampling inside
 * it is blocked. Screenshotting the ELEMENT is origin-independent and captures
 * exactly what a human sees; re-injecting that PNG as a same-origin data: URL
 * keeps the canvas untainted, with no decoder dependency.
 */
async function samplePreview(page: Page): Promise<{ px: number[]; rendered: boolean }> {
  const buf = await page.locator("iframe").first().screenshot({ timeout: 20_000 });
  const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
  const raw = await page.evaluate(async ({ url, stride }) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const out: number[][] = [];
    for (let y = Math.floor(img.height * 0.05); y < img.height * 0.95; y += stride) {
      for (let x = Math.floor(img.width * 0.05); x < img.width * 0.95; x += stride) {
        const d = g.getImageData(x, y, 1, 1).data;
        out.push([d[0], d[1], d[2]]);
      }
    }
    return out;
  }, { url: dataUrl, stride: 8 });
  return { px: modalColor(raw), rendered: looksRendered(raw) };
}

async function waitForColor(page: Page, want: string, budgetMs: number) {
  const deadline = Date.now() + budgetMs;
  let last = "unknown";
  while (Date.now() < deadline) {
    const s = await samplePreview(page).catch(() => null);
    if (s) {
      last = classifyVibeColor(s.px);
      if (last === want) return { ok: true, color: last };
    }
    await page.waitForTimeout(20_000);
  }
  return { ok: false, color: last };
}

/** Drive one full black → target → black arc on whichever surface is loaded. */
async function runVibeArc(page: Page, target: string) {
  // Vibing
  await page.getByText(/^Vibing$/).first().click().catch(() => {});
  await page.waitForTimeout(8000);

  const body = await page.evaluate(() => document.body.innerText);
  expect(body, "the box must both run and render for a single-box loop").toMatch(
    new RegExp(`${BOX}|runs and renders`, "i"),
  );

  // Project. Option VALUES are absolute paths while the LABEL reads
  // "yaver / mobile · expo", so match the label — a value-substring match
  // happily selects yaver-todo-rn.
  const projectSelect = page
    .locator("select")
    .filter({ has: page.locator("option", { hasText: new RegExp(PROJECT, "i") }) })
    .first();
  await expect(projectSelect, "the project catalogue must list the target project")
    .toHaveCount(1, { timeout: 60_000 });
  const opts = await projectSelect.locator("option").evaluateAll((els) =>
    els.map((e) => ({ value: (e as HTMLOptionElement).value, label: (e.textContent || "").trim() })),
  );
  const match = opts.find((o) => new RegExp(`^${PROJECT}\\b`, "i").test(o.label));
  expect(match, `no option labelled "${PROJECT}"`).toBeTruthy();
  await projectSelect.selectOption(match!.value);
  await page.waitForTimeout(6000);

  // The composer names the project that will ACTUALLY be vibed — verifying
  // page text alone passes on any screen that merely mentions the name.
  const placeholder = await page
    .getByPlaceholder(/Ask .* to change/i).first().getAttribute("placeholder");
  expect(placeholder || "", "composer must be pointed at the selected project")
    .toMatch(new RegExp(PROJECT, "i"));

  // Targets
  const loadTargets = page.getByRole("button", { name: /Load Targets/i }).first();
  if (await loadTargets.count()) await loadTargets.click().catch(() => {});
  await expect(openControls(page).first(), "the box must offer a render target")
    .toBeVisible({ timeout: 90_000 });

  // Open the BROWSER-LANE card by name. The list also offers "WebRTC over
  // browser"; opening the wrong card tests a different transport entirely.
  const n = await openControls(page).count();
  let opened = false;
  for (let i = 0; i < n; i++) {
    const btn = openControls(page).nth(i);
    const cardText = await btn.evaluate((el) => {
      let node: HTMLElement | null = el as HTMLElement;
      for (let up = 0; up < 5 && node?.parentElement; up++) node = node.parentElement;
      return (node?.innerText || "").slice(0, 200);
    });
    if (/web ui in browser/i.test(cardText)) { await btn.click(); opened = true; break; }
  }
  expect(opened, 'the "Web UI in browser" target was not offered').toBe(true);

  await expect(page.locator("iframe").first(), "the browser-lane preview must render")
    .toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(12_000);

  // Baseline. An EMPTY panel and a black app are identical to a sampler, so
  // require real content before trusting any colour reading.
  const base = await samplePreview(page);
  expect(base.rendered, "preview frame is empty — nothing to assert a colour against").toBe(true);

  // → target
  const composer = page.getByPlaceholder(/Ask .* to change/i).first();
  await composer.fill(`Change the login page background color to ${target}. Only the login screen background.`);
  await page.getByRole("button", { name: /^Send$/ }).first().click();
  await page.waitForTimeout(3000);
  const hit = await waitForColor(page, target, TURN_BUDGET_MS);
  expect(hit.ok, `preview never turned ${target} (last ${hit.color})`).toBe(true);

  // Revert as a SEPARATE task — exercises the new-task render path, not just a
  // follow-up on a warm session.
  const newSession = page.getByRole("button", { name: /New session/i }).first();
  if (await newSession.count()) { await newSession.click().catch(() => {}); await page.waitForTimeout(3000); }
  await composer.fill("Revert the login page background color back to black.");
  await page.getByRole("button", { name: /^Send$/ }).first().click();
  await page.waitForTimeout(3000);
  const back = await waitForColor(page, "black", TURN_BUDGET_MS);
  expect(back.ok, `preview never reverted to black (last ${back.color})`).toBe(true);
}

test.describe("vibe colour closed loop", () => {
  test.skip(!creds().email || !creds().password,
    "needs YAVER_TEST_EMAIL / YAVER_TEST_PASSWORD — an environment gap is not a product defect");
  // One dev-server slot on the box, and each arc edits the same file.
  test.describe.configure({ mode: "serial", timeout: 40 * 60_000 });

  test("web dashboard: black → red → black on the browser lane", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1100 });
    await signInWithPassword(page);
    await runVibeArc(page, "red");
  });

  // ── the MOBILE CLIENT arc ────────────────────────────────────────────────
  //
  // This drives the YAVER MOBILE APP as the client — the same RN app the user
  // holds, served as RN-web so Chromium can drive it — against the SAME box,
  // the SAME runner and the SAME browser lane as the web test above. The arc is
  // identical on purpose: any difference observed is then the SURFACE, not the
  // scenario.
  //
  // It needs a URL for the RN-web build (`cd mobile && npm run web`, or a
  // deployed one) in MOBILE_WEB_URL. It is SKIPPED, not failed, without one.
  //
  // An earlier version of this test simply shrank the viewport and drove the
  // web dashboard, then called itself "mobile RN-web". That is a false
  // equivalence: the dashboard and the RN app share neither their transport
  // ladder, their auth storage (RN-web keys the token as
  // `yaver.secure.yaver_auth_token`, the dashboard as `yaver_auth_token`), nor
  // their render path. A green result there would have said nothing about the
  // app the user actually holds — the exact class of false confidence this
  // suite exists to prevent, reproduced inside the suite.
  test("mobile app (RN-web client): black → red → black on the browser lane", async ({ page }) => {
    const mobileUrl = process.env.MOBILE_WEB_URL || "";
    test.skip(!mobileUrl,
      "set MOBILE_WEB_URL to the Yaver RN-web build (cd mobile && npm run web). " +
      "Refusing to shrink the dashboard viewport and call it the mobile app.");

    await page.setViewportSize({ width: 390, height: 844 });
    // RN-web stores the session under a DIFFERENT key than the dashboard —
    // seeding the wrong one leaves the app on its login screen forever.
    const token = process.env.YAVER_TEST_TOKEN || "";
    if (token) {
      await page.addInitScript((t) => {
        localStorage.setItem("yaver.secure.yaver_auth_token", t as string);
      }, token);
    }
    await page.goto(mobileUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(8000);
    await runVibeArc(page, "red");
  });
});
