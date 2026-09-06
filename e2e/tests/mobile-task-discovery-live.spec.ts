import { chromium, devices, expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { profileFor, viewportMatchesSurface } from "../../web/lib/surfaceViewports";

type LiveTask = {
  id: string;
  title: string;
  status: string;
  runnerId: string;
  model: string;
  reasoningEffort: string;
  tmuxSession: string;
  tmuxPaneId: string;
  [key: string]: unknown;
};

const mobileURL = (process.env.MOBILE_WEB_URL || "").replace(/\/$/, "");
const manifestPath = process.env.YAVER_TEST_LIVE_TASK_MANIFEST || "";

function localConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".yaver", "config.json"), "utf8"));
  } catch {
    return {};
  }
}

test("real Mac tmux runner panes render as ordinary mobile Tasks", async ({}, testInfo) => {
  test.skip(!mobileURL || !manifestPath, "needs MOBILE_WEB_URL + YAVER_TEST_LIVE_TASK_MANIFEST");

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { session: string; tasks: LiveTask[] };
  expect(manifest.session).toBe("141");
  expect(manifest.tasks.length).toBeGreaterThan(0);
  expect(new Set(manifest.tasks.map((task) => task.tmuxPaneId)).size).toBe(manifest.tasks.length);
  for (const task of manifest.tasks) {
    expect(task.runnerId).toBe("codex");
    expect(task.model).toBe("gpt-5.6-sol");
    expect(task.reasoningEffort).toBe("high");
  }

  const config = localConfig();
  const token = String(config.auth_token || "");
  const convex = String(config.convex_site_url || "").replace(/\/$/, "");
  test.skip(!token || !convex, "signed-in local Yaver config is required");

  const authResponse = await fetch(`${convex}/auth/validate?_=${Date.now()}`, {
    headers: { Authorization: `Bearer ${token}`, "Cache-Control": "no-store" },
    signal: AbortSignal.timeout(10_000),
  });
  expect(authResponse.ok).toBe(true);
  const authPayload = await authResponse.json() as { user?: Record<string, unknown> };
  const row = authPayload.user || {};
  const user = {
    id: row.userId,
    email: row.email,
    name: row.fullName,
    provider: row.provider,
    emailVerified: row.emailVerified,
    surveyCompleted: row.surveyCompleted,
    isOwner: row.isOwner,
  };

  const profile = profileFor("mobile");
  const executablePath = [
    process.env.YAVER_CHROMIUM_PATH,
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const context = await browser.newContext({ ...devices[profile.playwrightDevice!] });
  const page = await context.newPage();
  const agentRequests: string[] = [];
  let remainingTasks = [...manifest.tasks];

  // The installed signed agent may be one release behind the source under
  // test. Keep its real device/connectivity path, but serve the prompt-free
  // manifest produced moments earlier by the NEW Go detector. This proves the
  // real RN-web component tree without replacing or restarting the user's
  // running agent—or touching any tmux pane.
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === convex && url.pathname === "/task-snapshots" && request.method() === "GET") {
      // The live detector manifest is the owning-agent truth for this isolated
      // run. A previously published snapshot from the older signed agent must
      // not erase it before the source-under-test can publish its replacement.
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    if (url.origin !== convex && url.pathname === "/tasks" && request.method() === "GET" && request.resourceType() !== "document") {
      agentRequests.push("GET /tasks");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, tasks: remainingTasks }),
      });
      return;
    }
    if (url.origin !== convex && url.pathname === "/tasks/reconcile" && request.method() === "POST") {
      agentRequests.push("POST /tasks/reconcile");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, discovered: manifest.tasks.length }),
      });
      return;
    }
    if (url.origin !== convex && /\/tasks\/[^/]+$/.test(url.pathname) && request.method() === "DELETE") {
      agentRequests.push(`DELETE ${url.pathname}`);
      const taskId = decodeURIComponent(url.pathname.split("/").at(-1) || "");
      remainingTasks = remainingTasks.filter((task) => task.id !== taskId);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.continue();
  });

  await page.addInitScript(({ session, appUser }) => {
    localStorage.setItem("yaver_installed", "1");
    localStorage.setItem("yaver.secure.yaver_auth_token", session);
    localStorage.setItem("yaver.secure.yaver_user", JSON.stringify(appUser));
  }, { session: token, appUser: user });

  try {
    await page.goto(`${mobileURL}/tasks`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await expect(page.getByText("Connected", { exact: true }).first()).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(`Active · ${manifest.tasks.length}`, { exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(manifest.tasks[0].title, { exact: true })).toHaveCount(manifest.tasks.length);
    await expect(page.getByText("gpt-5.6-sol · high", { exact: true })).toHaveCount(manifest.tasks.length);
    await expect(page.getByText(/Yaver Sessions|Adopt Session|Attach Session|Yaver session ·|tmux/i)).toHaveCount(0);
    await expect(page.getByText(/Couldn't switch|Try again|Remote Box/, { exact: false })).toHaveCount(0);
    expect(agentRequests.filter((request) => request === "GET /tasks").length).toBeGreaterThan(0);

    const viewport = page.viewportSize()!;
    const signals = await page.evaluate(() => ({
      isMobile: /Mobile|iPhone|Android/i.test(navigator.userAgent),
      hasTouch: navigator.maxTouchPoints > 0,
    }));
    const verdict = viewportMatchesSurface("mobile", { ...viewport, ...signals });
    expect(verdict.ok, verdict.reason).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("live-codex-tasks.png"), fullPage: true });

    await page.getByRole("button", { name: "Select tasks" }).click();
    await page.getByRole("button", { name: "Select all visible tasks" }).click();
    await expect(page.getByRole("button", { name: `Delete ${manifest.tasks.length} selected tasks` })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("live-codex-tasks-selected.png"), fullPage: true });
    await page.getByRole("button", { name: `Delete ${manifest.tasks.length} selected tasks` }).click();
    await expect(page.getByText("Active · 0", { exact: true })).toBeVisible();
    expect(agentRequests.filter((request) => request.startsWith("DELETE "))).toHaveLength(manifest.tasks.length);
  } finally {
    await context.close();
    await browser.close();
  }
});
