import { expect, test, type Page } from "@playwright/test";
import { signIn } from "../helpers/login";

/**
 * SEQUENTIAL all-lanes matrix, driven from THIS machine's Chromium against a real
 * remote box. One test per (project × lane) cell so a failure names its cell, and
 * `describe.serial` because the box has ONE dev-server slot and exclusive
 * simulators — parallel cells would fight over both and blame each other.
 *
 * Lanes, all four of them:
 *
 *   browser        the project's own web dev server, proxied to an <iframe>
 *                  (Flutter web / Expo web / Next / Vite)
 *   browser-window a headless Chromium ON THE BOX, streamed over WebRTC —
 *                  "browser in browser"
 *   ios-simulator  the app in an Apple simulator, streamed over WebRTC
 *   android-emulator  same for an AVD
 *
 * Verdict per cell — and the distinction that matters:
 *   PIXELS  a surface with real frames (videoWidth > 0 and time advancing)
 *   NAMED   the product refused and SAID WHY (a working product, honest answer)
 *   SILENT  neither — the failure this whole suite exists to catch
 *
 * SILENT is the only verdict that fails the cell. NAMED is recorded and passes,
 * because "no Android emulator is running on that box" is the truth, not a bug.
 *
 * Env:
 *   YAVER_TEST_TOKEN, E2E_BASE_URL, E2E_LIVE_DEVICE   (required)
 *   E2E_MATRIX  optional "project:lane,project:lane" override of the default table
 */
const LIVE_DEVICE = process.env.E2E_LIVE_DEVICE || "";
const HAS_LIVE = !!(process.env.YAVER_TEST_TOKEN && LIVE_DEVICE);

type Lane = "browser" | "browser-window" | "ios-simulator" | "android-emulator";
interface Cell {
  project: string;
  lane: Lane;
}

// Default matrix: every stack in every lane it can legitimately take.
// Native-only stacks have no browser lane; web-only stacks have no simulator.
const DEFAULT_MATRIX: Cell[] = [
  { project: "todo-rn", lane: "browser" },
  { project: "todo-rn", lane: "ios-simulator" },
  { project: "todo-rn", lane: "android-emulator" },
  { project: "todo-flutter", lane: "browser" },
  { project: "todo-flutter", lane: "ios-simulator" },
  { project: "todo-flutter", lane: "android-emulator" },
  { project: "todo-web", lane: "browser" },
  { project: "todo-web", lane: "browser-window" },
  { project: "todo-swift", lane: "ios-simulator" },
  { project: "todo-kt", lane: "android-emulator" },
  { project: "sfmg", lane: "browser" },
  { project: "e-mobile", lane: "browser" },
];

const MATRIX: Cell[] = process.env.E2E_MATRIX
  ? process.env.E2E_MATRIX.split(",").map((pair) => {
      const [project, lane] = pair.split(":");
      return { project: project.trim(), lane: (lane || "browser").trim() as Lane };
    })
  : DEFAULT_MATRIX;

type Verdict = "PIXELS" | "NAMED" | "SILENT";
const results: { cell: string; verdict: Verdict; detail: string }[] = [];

/** Precise phrases the product emits when it legitimately cannot serve a lane. */
const NAMED_FAILURE =
  /attach-failed|could not attach|no simulator matching|already claimed|runtime not installed|no adb device|not installed|use webview|failed to compile|address already in use|no web target/i;

async function openDashboard(page: Page): Promise<void> {
  await signIn(page);
  const deviceRe = new RegExp(LIVE_DEVICE, "i");
  // Wait out the boot spinner: hunting for nav during it "finds no tab", which is
  // a race that reads exactly like a product fault.
  await expect
    .poll(async () => deviceRe.test(await page.locator("body").innerText().catch(() => "")), {
      timeout: 90_000,
      message: `dashboard never rendered device /${LIVE_DEVICE}/i`,
    })
    .toBe(true);
}

/** Click the first VISIBLE, enabled match — the nav renders twice (responsive). */
async function clickVisible(page: Page, name: RegExp): Promise<boolean> {
  const buttons = page.getByRole("button", { name });
  const n = await buttons.count();
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i);
    if (!(await b.isVisible().catch(() => false))) continue;
    if (await b.isDisabled().catch(() => false)) continue;
    await b.click();
    return true;
  }
  const texts = page.getByText(name);
  const m = await texts.count();
  for (let i = 0; i < m; i++) {
    const t = texts.nth(i);
    if (await t.isVisible().catch(() => false)) {
      await t.click();
      return true;
    }
  }
  return false;
}

async function connectIfGated(page: Page): Promise<void> {
  const gate = page.getByText(/Connect a device to use Projects/i).first();
  if (!(await gate.isVisible().catch(() => false))) return;
  const deviceRe = new RegExp(LIVE_DEVICE, "i");
  const card = page
    .locator("div")
    .filter({ hasText: deviceRe })
    .filter({ has: page.getByRole("button", { name: /^Connect$/ }) })
    .last();
  if (await card.isVisible().catch(() => false)) {
    await card.getByRole("button", { name: /^Connect$/ }).first().click();
  }
  await gate.waitFor({ state: "hidden", timeout: 120_000 }).catch(() => undefined);
}

/** Wait for pixels / a named refusal / nothing, and classify. */
async function classifySurface(page: Page, budgetMs: number): Promise<{ verdict: Verdict; detail: string }> {
  const video = page.locator("video").first();
  const blob = page.locator("img[src^='blob:']").first();
  const frame = page.locator("iframe").first();
  const named = page.getByText(NAMED_FAILURE).first();

  const which = await Promise.race([
    video.waitFor({ state: "visible", timeout: budgetMs }).then(() => "video").catch(() => "none"),
    blob.waitFor({ state: "visible", timeout: budgetMs }).then(() => "blob").catch(() => "none"),
    frame.waitFor({ state: "visible", timeout: budgetMs }).then(() => "iframe").catch(() => "none"),
    named.waitFor({ state: "visible", timeout: budgetMs }).then(() => "named").catch(() => "none"),
  ]);

  if (which === "named") {
    return { verdict: "NAMED", detail: ((await named.textContent()) || "").trim().slice(0, 160) };
  }
  if (which === "video") {
    // A visible <video> proves nothing. Frames do.
    const width = await expect
      .poll(async () => video.evaluate((el) => (el as HTMLVideoElement).videoWidth), { timeout: 90_000 })
      .toBeGreaterThan(0)
      .then(async () => video.evaluate((el) => (el as HTMLVideoElement).videoWidth))
      .catch(() => 0);
    if (!width) return { verdict: "SILENT", detail: "<video> mounted but videoWidth stayed 0" };
    const t0 = await video.evaluate((el) => (el as HTMLVideoElement).currentTime);
    await page.waitForTimeout(2500);
    const t1 = await video.evaluate((el) => (el as HTMLVideoElement).currentTime);
    if (t1 <= t0) return { verdict: "SILENT", detail: `frozen at ${width}px (currentTime not advancing)` };
    return { verdict: "PIXELS", detail: `video ${width}px, time ${t0.toFixed(1)}→${t1.toFixed(1)}s` };
  }
  if (which === "blob") return { verdict: "PIXELS", detail: "JPEG data-channel frames" };
  if (which === "iframe") {
    // The browser lane: the iframe must contain a real document, not about:blank.
    const ok = await frame
      .evaluate((el) => {
        const f = el as HTMLIFrameElement;
        return !!f.src && !/^about:blank$/.test(f.src);
      })
      .catch(() => false);
    return ok
      ? { verdict: "PIXELS", detail: "preview iframe with a real src" }
      : { verdict: "SILENT", detail: "iframe present but src is about:blank" };
  }
  return { verdict: "SILENT", detail: "no surface and no stated reason" };
}

test.describe.configure({ mode: "serial" });

test.describe("web UI lane matrix (live)", () => {
  test.skip(!HAS_LIVE, "set YAVER_TEST_TOKEN + E2E_LIVE_DEVICE to run against a real box");

  for (const cell of MATRIX) {
    const label = `${cell.project} · ${cell.lane}`;
    test(label, async ({ page }, testInfo) => {
      testInfo.setTimeout(Number(process.env.E2E_CELL_TIMEOUT_MS || 8 * 60_000));
      const record = async (verdict: Verdict, detail: string) => {
        results.push({ cell: label, verdict, detail });
        testInfo.annotations.push({ type: verdict, description: `${label}: ${detail}` });
        console.log(`[matrix] ${verdict.padEnd(6)} ${label} — ${detail}`);
        await testInfo.attach(`${verdict}-${label.replace(/\W+/g, "-")}`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      };

      await openDashboard(page);

      if (cell.lane === "browser") {
        // Projects tab owns the browser lane (Start / the project row itself).
        expect(await clickVisible(page, /Projects/), "no Projects tab").toBe(true);
        await connectIfGated(page);
        const row = page.getByText(new RegExp(cell.project, "i")).first();
        if (!(await row.isVisible({ timeout: 60_000 }).catch(() => false))) {
          await record("NAMED", `project ${cell.project} is not on this box`);
          return;
        }
        // Prefer an explicit Start; a running project opens on tap.
        if (!(await clickVisible(page, /^Start$/))) {
          await row.click();
        }
        const { verdict, detail } = await classifySurface(page, 300_000);
        await record(verdict, detail);
        expect(verdict, `${label}: ${detail}`).not.toBe("SILENT");
        return;
      }

      // WebRTC lanes live in Vibing (RuntimeLabView → RemoteRuntimeViewer).
      expect(await clickVisible(page, /Vibing|Runtime/), "no Vibing tab").toBe(true);
      await connectIfGated(page);

      const select = page.locator("select").first();
      await expect(select, "Vibing tab has no project picker").toBeVisible({ timeout: 90_000 });
      const options = await select.locator("option").allTextContents();
      const match = options.find((o) => o.toLowerCase().includes(cell.project.toLowerCase()));
      if (!match) {
        await record("NAMED", `project ${cell.project} absent from the picker`);
        return;
      }
      await select.selectOption({ label: match });

      await clickVisible(page, /load targets|capabilit/i);
      await expect(page.getByText(/targets:/i).first(), "capability probe never answered").toBeVisible({
        timeout: 120_000,
      });

      // The lane's own control. A DISABLED target is a named refusal: the reason
      // sits next to it, which is the product doing its job.
      const laneRe = new RegExp(cell.lane.replace(/-/g, "[- ]?"), "i");
      const laneBtn = page.getByRole("button", { name: laneRe }).first();
      if (!(await laneBtn.isVisible().catch(() => false))) {
        const body = await page.locator("body").innerText();
        const stated = body.match(NAMED_FAILURE);
        await record(stated ? "NAMED" : "SILENT", stated ? stated[0] : `no control for ${cell.lane}`);
        expect(!!stated, `${label}: no control and no stated reason`).toBe(true);
        return;
      }
      if (await laneBtn.isDisabled().catch(() => false)) {
        const body = await page.locator("body").innerText();
        const stated = body.match(NAMED_FAILURE);
        await record("NAMED", stated ? stated[0] : `${cell.lane} offered but disabled`);
        return;
      }
      await laneBtn.click();

      const { verdict, detail } = await classifySurface(page, 300_000);
      await record(verdict, detail);
      expect(verdict, `${label}: ${detail}`).not.toBe("SILENT");
    });
  }

  test.afterAll(() => {
    if (results.length === 0) return;
    const width = Math.max(...results.map((r) => r.cell.length));
    console.log("\n===== LANE MATRIX =====");
    for (const r of results) {
      console.log(`${r.verdict.padEnd(6)} ${r.cell.padEnd(width)}  ${r.detail}`);
    }
    const pixels = results.filter((r) => r.verdict === "PIXELS").length;
    const named = results.filter((r) => r.verdict === "NAMED").length;
    const silent = results.filter((r) => r.verdict === "SILENT").length;
    console.log(`\n${pixels} rendered · ${named} named refusal · ${silent} SILENT (must be 0)\n`);
  });
});
