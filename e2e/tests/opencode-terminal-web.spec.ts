import { expect, test, type Page } from "@playwright/test";
import { decodePng } from "../_framePixels.mjs";

/**
 * OpenCode raw-lane terminal view — closed loop on the web dashboard.
 *
 *   cd e2e
 *   YAVER_TEST_TOKEN=<owner token> npx playwright test tests/opencode-terminal-web.spec.ts
 *
 * ── What it proves (Task 6b of NEXT_DEV_TASKS.md, 2026-08-08 handoff) ─────
 *
 * The agent's raw SSE lane (`raw`/`raw_replay` frames, agent 1.99.406+,
 * commit d671b7c02) must PAINT a real terminal in the dashboard:
 *
 *   1. RUN   — an opencode task dispatched from the dashboard composer
 *              shows a Chat|Terminal toggle; the Terminal view mounts xterm
 *              and PAINTS the raw TUI (judged on the xterm canvas PIXELS,
 *              not a status badge).
 *   2. TOGGLE — switching Chat → Terminal → Chat → Terminal again must not
 *              duplicate the terminal (exactly one xterm mount, no doubled
 *              raw bytes on re-mount).
 *   3. DONE  — a COMPLETED opencode task's Terminal view seeds from
 *              getTask().rawOutput (the agent ships the last 64KB tail) —
 *              the finished task's raw tail paints with no live stream.
 *
 * Verdicts are PIXELS (canvas pixels + text read off the page) — never
 * SILENT. Environment gaps skip with a reason rather than fail.
 *
 * Credentials: YAVER_TEST_TOKEN (owner scope, from the box agent's config).
 * The token value is never printed; it travels via env only.
 */

const APP = process.env.WEB_URL || "http://127.0.0.1:3217";

function creds() {
  return { token: process.env.YAVER_TEST_TOKEN || "" };
}

function haveCreds() {
  return Boolean(creds().token);
}

/** Seed the dashboard session from a token (web uses the UNPREFIXED key). */
async function signIn(page: Page) {
  const { token } = creds();
  await page.addInitScript((t) => {
    try { localStorage.setItem("yaver_auth_token", t as string); } catch { /* about:blank */ }
    document.cookie = `yaver_auth_token=${t}; path=/; max-age=${60 * 60 * 24 * 30}; samesite=lax`;
  }, token);
  await page.goto(`${APP}/dashboard`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.evaluate((t) => localStorage.setItem("yaver_auth_token", t as string), token);
  await page.waitForURL(/\/(survey|dashboard)(?:$|\?)/, { timeout: 45_000 });
  if (page.url().includes("/survey")) await page.goto(`${APP}/dashboard`);
  await page.waitForTimeout(8000);
}

/**
 * Read the ACTUAL pixels of the rendered xterm element. xterm.js paints text
 * into a <canvas> and mirrors it into DOM rows; a status badge or a mounted
 * DOM row cannot prove the terminal RENDERED (a mounted-but-blank xterm is a
 * spinner with manners). So we screenshot the element and decode the PNG with
 * the repo's own decoder (`_framePixels.mjs`), then count non-background
 * pixels. xterm's theme background is #05070a.
 *
 * Returns {painted, bg, fg} where painted is the count of sampled pixels that
 * differ from the dominant background.
 */
async function xtermPixels(page: Page) {
  const xterm = page.locator(".xterm").first();
  const buf = await xterm.screenshot({ animations: "disabled" });
  const img = decodePng(buf);
  const { width, height, rgba } = img;
  if (!width || !height) return { painted: 0, bg: null, fg: null };
  // Sample a coarse grid; count pixels brighter than the #05070a background.
  const sample = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return [rgba[i], rgba[i + 1], rgba[i + 2]] as const;
  };
  const bg = sample(2, 2);
  let painted = 0;
  const seen = new Set<string>();
  const strideX = Math.max(2, Math.floor(width / 60));
  const strideY = Math.max(2, Math.floor(height / 40));
  for (let y = 4; y < height - 2; y += strideY) {
    for (let x = 4; x < width - 2; x += strideX) {
      const [r, g, b] = sample(x, y);
      // Anything meaningfully brighter than the background = painted glyph.
      if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) > 30) {
        painted += 1;
        seen.add(`${r},${g},${b}`);
      }
    }
  }
  return { painted, bg: bg.join(","), fg: [...seen][0] ?? null };
}

/** The raw text the xterm rows currently hold (what a user can read). */
async function xtermText(page: Page) {
  return page.evaluate(() => {
    const rows = document.querySelectorAll<HTMLElement>(".xterm-rows > div");
    return Array.from(rows).map((r) => r.innerText || "").join("\n");
  });
}

test.describe("opencode raw-lane terminal closed loop (web)", () => {
  test.setTimeout(420_000);
  test.skip(!haveCreds(),
    "needs YAVER_TEST_TOKEN (owner scope) — an environment gap is not a product defect");

  test("dashboard Terminal view paints the raw TUI, toggles without duplicates, and seeds a finished task", async ({ page }) => {
    await signIn(page);

    // Signed-in chrome proves the dashboard rendered.
    await expect(page.getByText(/^(Vibing|Devices)$/).first(),
      "dashboard must render signed-in chrome").toBeVisible({ timeout: 60_000 });

    // The dashboard may land on the Devices tab (auto-connect target). The
    // Chat|Terminal composer only exists in the Chat pane — navigate there.
    const chatNav = page.locator("aside").getByRole("button", { name: /Chat/i }).first();
    if (await chatNav.count()) {
      await chatNav.click();
      await page.waitForTimeout(1500);
    }

    // Wait for auto-connect to a reachable device (the owner's own online box
    // or the local agent). The composer must become usable — a disabled
    // composer means no connected device / no runner, which the product must
    // have named elsewhere.
    const composer = page.locator("textarea[placeholder*='Describe the task']").first();
    await expect(composer, "the task composer must render once a device connects").toBeVisible({ timeout: 90_000 });
    await expect(composer, "the composer must be enabled (device connected + runner ready)").toBeEnabled({ timeout: 60_000 });

    // 1. RUN: dispatch an opencode task whose expected raw output we know.
    const token = `TERMINAL_WEB_${Date.now().toString(36).toUpperCase()}`;
    await composer.fill(`Reply with exactly: ${token}`);
    await page.getByRole("button", { name: /Start task/ }).click();
    await page.waitForTimeout(2000);

    // The Chat|Terminal toggle appears for opencode tasks. The toggle buttons
    // carry aria-pressed; the sidebar nav "Chat"/"Devices" buttons do not —
    // scope to the toggle so a nav click can never masquerade as a view switch.
    const toggle = (name: "Chat" | "Terminal") =>
      page.locator(`button[aria-pressed]:has-text("${name}")`).first();
    const terminalBtn = toggle("Terminal");
    await expect(terminalBtn, "opencode tasks must show the Chat|Terminal toggle").toBeVisible({ timeout: 45_000 });

    // 2. TOGGLE → Terminal. xterm must mount AND paint real glyph pixels.
    await terminalBtn.click();
    const xterm = page.locator(".xterm").first();
    await expect(xterm, "xterm must mount").toBeVisible({ timeout: 30_000 });

    // Judge on PIXELS: the canvas must show painted glyphs within the run window.
    let pixels = await xtermPixels(page);
    if (pixels.painted === 0) {
      // The runner may take a moment to emit raw bytes; give the lane a chance
      // while polling the canvas, and only fail if it stays blank.
      for (let i = 0; i < 20 && pixels.painted === 0; i++) {
        await page.waitForTimeout(1500);
        pixels = await xtermPixels(page);
      }
    }
    expect(pixels.painted, `the xterm canvas must paint the raw TUI (painted=${pixels.painted} px, bg=${pixels.bg})`).toBeGreaterThan(0);

    // Read the painted text off the terminal: the runner's prompt echo is the
    // first raw bytes any opencode run emits (" > build · <model>" banner).
    const runText = await xtermText(page);
    expect(runText.length, "terminal must hold readable raw text").toBeGreaterThan(0);

    // 3. TOGGLE away and back — no duplicates: exactly one xterm, and the
    //    re-mounted terminal must not double the bytes already shown.
    await toggle("Chat").click();
    await page.waitForTimeout(800);
    await expect(xterm, "Chat view must unmount the terminal").toHaveCount(0);
    await toggle("Terminal").click();
    await page.waitForTimeout(1500);
    await expect(xterm, "Terminal view must remount a SINGLE xterm").toHaveCount(1);
    const remountedText = await xtermText(page);
    // The raw tail never shrinks on remount; and the banner text must not
    // appear doubled (a duplicate-mount bug renders the seed twice).
    const banner = remountedText.match(/build ·/g) || [];
    expect(banner.length, `raw seed must not duplicate on remount (saw ${banner.length} banners)`).toBeLessThanOrEqual(1);

    // 4. DONE: wait for completion, then flip to Chat and back — the finished
    //    task's Terminal seeds from getTask().rawOutput with NO live stream.
    const done = page.getByText(token).first();
    try {
      await expect(done, "the completed task's answer must appear").toBeVisible({ timeout: 240_000 });
    } catch {
      // The answer may have been cut from the raw tail by the 512KB cap only
      // for enormous runs — but this is a one-line reply, so absence is a fail.
      throw new Error("the task answer never appeared in the dashboard");
    }
    await page.waitForTimeout(3000); // let status reconcile to completed
    await toggle("Chat").click();
    await page.waitForTimeout(800);
    await toggle("Terminal").click();
    await page.waitForTimeout(1000);
    // The finished-task seed arrives async: getTask().rawOutput round-trips
    // to the box over the relay, then xterm boots and drains it. Poll for the
    // banner instead of trusting one fixed wait.
    let finalText = "";
    for (let i = 0; i < 20; i++) {
      finalText = await xtermText(page);
      if (finalText.includes("build ·")) break;
      await page.waitForTimeout(1500);
    }
    expect(finalText, "finished task Terminal must still paint the raw tail").toContain("build ·");
    const finalPixels = await xtermPixels(page);
    expect(finalPixels.painted, "finished task Terminal must paint glyphs").toBeGreaterThan(0);
  });
});
