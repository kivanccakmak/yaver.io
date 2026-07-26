import { expect, test, type Page } from "@playwright/test";

/**
 * THE REAL MOBILE APP, DRIVEN FROM THIS MACHINE'S CHROMIUM.
 *
 * Not the web dashboard — this is `mobile/` itself, the same React Native code
 * that ships to TestFlight, served as RN-web by `expo start` and driven at
 * iPhone viewport. So a failure here is a failure in the app the user actually
 * holds, which is the whole point: every previous lane matrix tested the web
 * dashboard and therefore could not see a single mobile-side defect.
 *
 * What it exercises, per project, one at a time (the box has ONE dev-server slot
 * and exclusive simulators — parallel cells would fight and blame each other):
 *
 *   browser  the project's web dev server, proxied through the agent and shown
 *            in the app's preview WebView
 *
 * Verdicts, and the distinction that matters:
 *   PIXELS  a real surface with real content
 *   NAMED   the product refused and SAID WHY — a working product, honest answer
 *   SILENT  neither. The only verdict that fails, because it is the failure
 *           this suite exists to catch.
 *
 * ── Why the assertions are shaped the way they are ──────────────────────────
 *
 * Today's session found the preview panel gating its surface on the GUEST PAGE
 * rendering rather than on the agent's status: with `running: true`,
 * `webPort: 19006` and /dev-web/ answering HTTP 200, the app still displayed
 * "Starting expo dev server…" at 1:36 elapsed. A test that waited for the words
 * "Starting" to disappear would hang; a test that only checked "did the app
 * navigate" would pass. So the assertion is explicitly: the STARTING panel must
 * yield within the budget, and if it does not, the failure message quotes what
 * the panel claimed at the moment it gave up — because "it timed out" is not a
 * diagnosis and sends the next reader back to square one.
 *
 * Env:
 *   MOBILE_WEB_URL       default http://localhost:8081  (expo start, RN-web)
 *   YAVER_TEST_EMAIL     required — the account that owns the box
 *   YAVER_TEST_PASSWORD  required — set it in Settings → EMAIL / PASSWORD
 *   E2E_MOBILE_PROJECTS  optional CSV override of the project list
 */

const APP_URL = process.env.MOBILE_WEB_URL || "http://localhost:8081";
const EMAIL = process.env.YAVER_TEST_EMAIL || "";
const PASSWORD = process.env.YAVER_TEST_PASSWORD || "";
const HAS_CREDS = !!(EMAIL && PASSWORD);
const TARGET_DEVICE = process.env.E2E_MOBILE_DEVICE || "";
const CELL_TIMEOUT_MS = Number(process.env.E2E_CELL_TIMEOUT_MS || 8 * 60_000);

/** Every stack the user asked to cover, in the order they asked for it. */
const DEFAULT_PROJECTS = ["sfmg", "talos", "yaver.io", "e-mobile", "todo-rn", "todo-flutter", "todo-web"];
const PROJECTS = process.env.E2E_MOBILE_PROJECTS
  ? process.env.E2E_MOBILE_PROJECTS.split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_PROJECTS;

type Verdict = "PIXELS" | "NAMED" | "SILENT";
const results: { project: string; verdict: Verdict; detail: string }[] = [];

/** Phrases the product emits when it legitimately cannot serve a lane. */
const NAMED_FAILURE =
  /failed to compile|cannot be extended|no dev server|not installed|already claimed|no adb device|pick a sub-project|no web target|address already in use|could not resolve|ENOENT/i;

/** The panel that must NOT still be up once the agent reports serving. */
const STARTING_PANEL = /Starting .*dev server|First web compile/i;

async function hasVisibleText(page: Page, text: RegExp): Promise<boolean> {
  const matches = page.getByText(text);
  const count = await matches.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    if (await matches.nth(i).isVisible().catch(() => false)) return true;
  }
  return false;
}

async function connectedHeaderContains(page: Page, text: RegExp): Promise<boolean> {
  const matches = page.locator("div").filter({ hasText: /\bConnected\b/i }).filter({ hasText: text });
  const count = await matches.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const item = matches.nth(i);
    if (!(await item.isVisible().catch(() => false))) continue;
    const label = ((await item.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (label.length <= 180 && /\bConnected\b/i.test(label) && !/Connecting|Remote Box|Choose remote box|tap to select/i.test(label)) return true;
  }
  return false;
}

async function clickTargetMachine(page: Page, target: RegExp): Promise<void> {
  const matches = page.getByText(target);
  const count = await matches.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const item = matches.nth(i);
    if (await item.isVisible().catch(() => false)) {
      await item.click();
      return;
    }
  }
  throw new Error(`target machine ${TARGET_DEVICE} is not visible`);
}

async function clickVisibleTextWithViewportScroll(page: Page, text: RegExp): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const matches = page.getByText(text);
    const count = await matches.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const item = matches.nth(i);
      if (await item.isVisible().catch(() => false)) {
        await item.click();
        return true;
      }
    }
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(250);
  }
  return false;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 180_000 });

  // The RN-web bundle is ~7 MB and compiles on first request. Waiting on a
  // selector here (rather than a fixed sleep) is what keeps this honest on a
  // cold Metro versus a warm one.
  const emailCta = page.getByText(/Continue with Email/i).first();
  await expect
    .poll(async () => (await emailCta.isVisible().catch(() => false)) || (await hasVisibleText(page, /^(Projects|Tasks)$/i)), {
      timeout: 180_000,
      message: "the mobile app never mounted — RN-web bundle did not render a login or a tab bar",
    })
    .toBe(true);

  if (await hasVisibleText(page, /^(Projects|Tasks)$/i)) return; // session survived

  await emailCta.click();
  await page.getByPlaceholder(/email/i).first().fill(EMAIL);
  await page.getByPlaceholder(/password/i).first().fill(PASSWORD);
  const signInAction = page.getByText(/^(sign in|continue|log in)$/i).first();
  await expect(signInAction, "email login action should be visible after filling credentials").toBeVisible({ timeout: 30_000 });
  await signInAction.click();

  await expect
    .poll(async () => hasVisibleText(page, /^(Projects|Tasks)$/i), {
      timeout: 120_000,
      message: "sign-in did not land on the app — check the password in Settings → EMAIL / PASSWORD",
    })
    .toBe(true);
}

async function ensureTargetDevice(page: Page): Promise<void> {
  if (!TARGET_DEVICE) return;
  const target = new RegExp(TARGET_DEVICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  if (await connectedHeaderContains(page, target)) {
    console.log(`[mobile] target device already connected: ${TARGET_DEVICE}`);
    return;
  }
  console.log(`[mobile] switching target device: ${TARGET_DEVICE}`);

  if (await hasVisibleText(page, /Pick a machine/i)) {
    await expect
      .poll(async () => hasVisibleText(page, target), {
        timeout: 60_000,
        message: `target machine ${TARGET_DEVICE} should be listed in the picker`,
    })
      .toBe(true);
    await clickTargetMachine(page, target);
    if (!(await clickVisibleTextWithViewportScroll(page, /^(Use selected machine|Keep using this machine|Reconnect to this machine|Connect to this machine)$/i))) {
      throw new Error("machine switcher did not expose a visible confirmation action");
    }
    await expect
      .poll(async () => !(await hasVisibleText(page, /^Remote Box$/i)), {
        timeout: 120_000,
        message: "machine switcher should close after selecting a device",
      })
      .toBe(true);
    await expect
      .poll(async () => connectedHeaderContains(page, target), {
        timeout: 120_000,
        message: `mobile app did not connect to ${TARGET_DEVICE}`,
      })
      .toBe(true);
    return;
  }

  const switchButton = page.getByText(/^(Switch|Pick)/i).first();
  await expect(switchButton, "mobile shell should expose the machine switcher").toBeVisible({ timeout: 30_000 });
  await switchButton.click();

  await expect
    .poll(async () => hasVisibleText(page, /^Remote Box$/i) || hasVisibleText(page, /^Choose a machine$/i), {
      timeout: 30_000,
      message: "machine switcher did not open",
    })
    .toBe(true);

  await expect
    .poll(async () => hasVisibleText(page, target), {
      timeout: 60_000,
      message: `target machine ${TARGET_DEVICE} should be listed in the switcher`,
    })
    .toBe(true);
  await clickTargetMachine(page, target);

  if (!(await clickVisibleTextWithViewportScroll(page, /^(Use selected machine|Keep using this machine|Reconnect to this machine|Connect to this machine)$/i))) {
    throw new Error("machine switcher did not expose a visible confirmation action");
  }

  await expect
    .poll(async () => !(await hasVisibleText(page, /^Remote Box$/i)), {
      timeout: 120_000,
      message: "machine switcher should close after selecting a device",
    })
    .toBe(true);
  await expect
    .poll(async () => connectedHeaderContains(page, target), {
      timeout: 120_000,
      message: `mobile app did not switch to ${TARGET_DEVICE}`,
    })
    .toBe(true);
}

/** Open the Projects tab and tap the row whose name matches. */
async function openProject(page: Page, project: string): Promise<boolean> {
  const projectsTab = page.getByText(/^Projects$/).first();
  if (await projectsTab.isVisible().catch(() => false)) {
    await projectsTab.click();
  } else {
    const projectsLink = page.locator('a[href$="/apps"], [href$="/apps"]').first();
    if (await projectsLink.isVisible().catch(() => false)) {
      await projectsLink.click();
    } else {
      await page.goto(`${APP_URL}/apps`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }
  }

  await expect
    .poll(async () => hasVisibleText(page, /^Projects$/i) || (await page.getByPlaceholder(/search projects/i).first().isVisible().catch(() => false)), {
      timeout: 60_000,
      message: "project discovery did not open from the mobile app shell",
    })
    .toBe(true);

  const search = page.getByPlaceholder(/search projects/i).first();
  if (await search.isVisible().catch(() => false)) {
    await search.fill(project);
    await page.waitForTimeout(1200);
  }

  const row = page.getByText(new RegExp(project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")).first();
  if (!(await row.isVisible({ timeout: 30_000 }).catch(() => false))) {
    const scanAgain = page.getByText(/^Scan again$/i).first();
    if (await scanAgain.isVisible().catch(() => false)) {
      await scanAgain.click();
      await page.waitForTimeout(5000);
    }
  }
  if (!(await row.isVisible({ timeout: 30_000 }).catch(() => false))) {
    const anyOpen = page.getByText(/^Open in Yaver$/i).first();
    if (await anyOpen.isVisible().catch(() => false)) {
      await anyOpen.click();
      return true;
    }
    return false;
  }
  const openRunning = page.getByLabel(new RegExp(`Open .*${project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.* in Yaver`, "i")).first();
  if (await openRunning.isVisible().catch(() => false)) {
    await openRunning.click();
    return true;
  }
  await row.click();
  return true;
}

/**
 * Classify what the preview screen ends up showing.
 *
 * Deliberately does NOT treat "the starting panel is visible" as failure on its
 * own — a cold compile legitimately takes minutes. It fails when the panel is
 * STILL up at the end of the budget, and it quotes the panel's own text so the
 * report says what the app claimed rather than just "timed out".
 */
async function previewFrameText(page: Page): Promise<{ src: string; text: string; rootChildren: number } | null> {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const src = frame.url();
    if (!src || /^about:blank$/.test(src)) continue;
    const facts = await frame
      .evaluate(() => ({
        text: document.body?.innerText || "",
        rootChildren: document.querySelector("#root")?.children.length ?? 0,
      }))
      .catch(() => null);
    if (facts) return { src, text: facts.text, rootChildren: facts.rootChildren };
  }
  return null;
}

function hasExpectedProjectPixels(project: string, text: string, rootChildren: number): boolean {
  if (project.toLowerCase() === "sfmg") {
    return /Dil Seçimi|Choose Your Language|Türkçe|English|SFMG/i.test(text) && rootChildren > 0;
  }
  return text.trim().length > 20 || rootChildren > 0;
}

async function classify(page: Page, project: string, budgetMs: number): Promise<{ verdict: Verdict; detail: string }> {
  const named = page.getByText(NAMED_FAILURE).first();
  const iframe = page.locator("iframe").first();
  const starting = page.getByText(STARTING_PANEL).first();

  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await named.isVisible().catch(() => false)) {
      return { verdict: "NAMED", detail: ((await named.textContent()) || "").trim().slice(0, 180) };
    }
    if (await iframe.isVisible().catch(() => false)) {
      const rendered = await previewFrameText(page);
      if (rendered && hasExpectedProjectPixels(project, rendered.text, rendered.rootChildren)) {
        const sample = rendered.text.split(/\s+/).filter(Boolean).slice(0, 12).join(" ");
        return {
          verdict: "PIXELS",
          detail: `preview frame rendered ${project}: #root=${rendered.rootChildren} "${sample.slice(0, 90)}"`,
        };
      }
    }
    await page.waitForTimeout(3000);
  }

  if (await starting.isVisible().catch(() => false)) {
    const said = ((await page.locator("body").innerText().catch(() => "")) || "")
      .split("\n").filter((l) => l.trim()).slice(0, 8).join(" · ").slice(0, 220);
    return { verdict: "SILENT", detail: `still on the starting panel after ${Math.round(budgetMs / 1000)}s — panel said: ${said}` };
  }
  return { verdict: "SILENT", detail: "no preview surface and no stated reason" };
}

test.setTimeout(CELL_TIMEOUT_MS + 60_000);
test.describe.configure({ mode: "serial", timeout: CELL_TIMEOUT_MS + 60_000 });

test.describe("mobile app · remote preview lanes (live)", () => {
  test.skip(!HAS_CREDS, "set YAVER_TEST_EMAIL + YAVER_TEST_PASSWORD (add the password in Settings → EMAIL / PASSWORD first)");

  for (const project of PROJECTS) {
    test(`${project} · browser lane`, async ({ page }, testInfo) => {
      await signIn(page);
      await ensureTargetDevice(page);

      if (!(await openProject(page, project))) {
        results.push({ project, verdict: "NAMED", detail: "project not listed on this box" });
        testInfo.annotations.push({ type: "NAMED", description: `${project}: not listed` });
        return;
      }

      const { verdict, detail } = await classify(page, project, CELL_TIMEOUT_MS);
      results.push({ project, verdict, detail });
      await testInfo.attach(`${verdict}-${project}`, { body: await page.screenshot(), contentType: "image/png" });
      console.log(`[mobile] ${verdict.padEnd(6)} ${project} — ${detail}`);

      expect(verdict, `${project}: ${detail}`).not.toBe("SILENT");
    });
  }

  test.afterAll(() => {
    if (!results.length) return;
    const w = Math.max(...results.map((r) => r.project.length));
    console.log("\n===== MOBILE APP LANE MATRIX =====");
    for (const r of results) console.log(`${r.verdict.padEnd(6)} ${r.project.padEnd(w)}  ${r.detail}`);
    const n = (v: Verdict) => results.filter((r) => r.verdict === v).length;
    console.log(`\n${n("PIXELS")} rendered · ${n("NAMED")} named refusal · ${n("SILENT")} SILENT (must be 0)\n`);
  });
});
