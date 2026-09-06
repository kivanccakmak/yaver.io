import { chromium, devices, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { profileFor, viewportMatchesSurface } from "../../web/lib/surfaceViewports";

type TaskRow = {
  id: string;
  title: string;
  status: string;
  runnerId?: string;
  model?: string;
  reasoningEffort?: string;
  deviceName?: string;
};

type Snapshot = {
  deviceId: string;
  tasks: Array<{ taskId: string; status: string }>;
};

const mobileURL = (process.env.MOBILE_WEB_URL || "").replace(/\/$/, "");
const agentURL = (process.env.YAVER_TEST_AGENT_URL || "http://127.0.0.1:18080").replace(/\/$/, "");
const fixtureTitles = [
  "Task sync disposable fixture A",
  "Task sync disposable fixture B",
] as const;

function localConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".yaver", "config.json"), "utf8"));
  } catch {
    return {};
  }
}

async function jsonRequest<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${init.method || "GET"} ${new URL(url).pathname} returned HTTP ${response.status}`);
  return await response.json() as T;
}

async function localTasks(token: string): Promise<TaskRow[]> {
  const payload = await jsonRequest<{ tasks: TaskRow[] }>(`${agentURL}/tasks`, token);
  return payload.tasks || [];
}

async function waitForLocalTask(token: string, taskId: string, want: string | null): Promise<void> {
  await expect.poll(async () => {
    const row = (await localTasks(token)).find((task) => task.id === taskId);
    return row?.status || null;
  }, { timeout: 30_000, intervals: [250, 500, 1_000] }).toBe(want);
}

async function waitForSnapshotTask(
  convexURL: string,
  token: string,
  deviceId: string,
  taskId: string,
  want: string | null,
): Promise<void> {
  await expect.poll(async () => {
    const snapshots = await jsonRequest<Snapshot[]>(`${convexURL}/task-snapshots`, token);
    const snapshot = snapshots.find((row) => row.deviceId === deviceId);
    return snapshot?.tasks.find((task) => task.taskId === taskId)?.status || null;
  }, { timeout: 40_000, intervals: [500, 1_000] }).toBe(want);
}

async function deleteExactTask(token: string, controllerId: string, taskId: string): Promise<void> {
  if (!taskId || taskId === controllerId) throw new Error("refusing to delete the controller Task");
  const response = await fetch(`${agentURL}/tasks/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`DELETE /tasks/{fixture} returned HTTP ${response.status}`);
  }
}

function normalizedTaskPath(rawURL: string): string | null {
  const match = new URL(rawURL).pathname.match(/(\/tasks(?:\/.*)?)$/);
  return match?.[1] || null;
}

async function assertOwningDeviceFocused(page: Page, deviceName: string): Promise<void> {
  const targetName = deviceName.trim();
  if (!targetName) throw new Error("controller Task did not include its owning device name");
  // This accessibility label is built from DeviceContext.activeDevice, not a
  // Task card's historical deviceName, so it proves the browser connected to
  // the owning box before any local Task assertion is trusted.
  await expect(page.getByLabel(`Change coding agent on ${targetName}`)).toBeVisible({ timeout: 60_000 });
}

test.use({ screenshot: "off", trace: "off", video: "off" });

test("live Ubuntu Tasks synchronize through the real RN-web mobile surface", async () => {
  test.setTimeout(240_000);
  test.skip(!mobileURL, "needs MOBILE_WEB_URL pointing at the real RN-web app");

  const config = localConfig();
  const token = String(config.auth_token || "");
  const convexURL = String(config.convex_site_url || "").replace(/\/$/, "");
  const deviceId = String(config.device_id || config.deviceId || "");
  const controllerId = String(process.env.YAVER_TASK_ID || "");
  test.skip(!token || !convexURL || !deviceId || !controllerId, "signed-in local Yaver config and controller identity are required");
  const auth = await jsonRequest<{ user?: { userId?: string } }>(`${convexURL}/auth/validate?_=${Date.now()}`, token);
  const userId = String(auth.user?.userId || "");
  expect(userId, "auth validation must provide the user-scoped device preference key").not.toBe("");

  const fixtureIds: string[] = [];
  let context: BrowserContext | null = null;
  let browser: Browser | null = null;
  try {
    console.log("[task-sync-live] preparing isolated fixtures");
    // Interrupted reruns may leave only these public, unmistakably disposable
    // fixture names. Remove those exact rows before asserting the Completed
    // tab is isolated; never use delete-all and never touch an arbitrary row.
    for (const task of await localTasks(token)) {
      if (fixtureTitles.includes(task.title as typeof fixtureTitles[number])) {
        await deleteExactTask(token, controllerId, task.id);
        await waitForSnapshotTask(convexURL, token, deviceId, task.id, null);
      }
    }
    expect((await localTasks(token)).filter((task) => task.status === "completed"),
      "Completed must be empty so Select all is scoped only to disposable fixtures").toHaveLength(0);
    expect((await localTasks(token)).find((task) => task.id === controllerId)?.status).toBe("running");

    for (const title of fixtureTitles) {
      const created = await jsonRequest<{ taskId: string }>(`${agentURL}/tasks`, token, {
        method: "POST",
        // Keep the process alive until the test deliberately completes it.
        // A naturally exiting one-line shell command races the agent's process
        // waiter and snapshot poll under load; an explicit lifecycle verb makes
        // every state transition independently observable and deterministic.
        body: JSON.stringify({ title, customCommand: "sleep 300", source: "cli" }),
      });
      expect(created.taskId).not.toBe(controllerId);
      fixtureIds.push(created.taskId);
      await waitForLocalTask(token, created.taskId, "running");
      await waitForSnapshotTask(convexURL, token, deviceId, created.taskId, "running");
      await jsonRequest(`${agentURL}/tasks/${encodeURIComponent(created.taskId)}/complete`, token, {
        method: "POST",
      });
      await waitForLocalTask(token, created.taskId, "completed");
      await waitForSnapshotTask(convexURL, token, deviceId, created.taskId, "completed");
    }

    console.log("[task-sync-live] launching genuine iPhone context");
    const executablePath = [
      process.env.YAVER_CHROMIUM_PATH,
      "/usr/local/bin/chromium",
      "/usr/bin/chromium-browser",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    context = await browser.newContext({ ...devices["iPhone 15 Pro"] });
    const page = await context.newPage();
    const agentRequests: string[] = [];
    page.on("request", (request) => {
      const path = normalizedTaskPath(request.url());
      if (path) agentRequests.push(`${request.method()} ${path}`);
    });

    // The bearer exists in one browser storage location only. AuthContext
    // validates it and loads the user normally; no token is put in a URL,
    // screenshot, trace, or test artifact.
    await page.addInitScript(({ session, stickyKey, owningDeviceId }) => {
      localStorage.setItem("yaver_installed", "1");
      localStorage.setItem("yaver.secure.yaver_auth_token", session);
      localStorage.setItem(stickyKey, owningDeviceId);
    }, {
      session: token,
      stickyKey: `@yaver/u/${userId}/last_selected_device`,
      owningDeviceId: deviceId,
    });

    await page.goto(`${mobileURL}/tasks`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await expect(page.getByText("Connected", { exact: true }).first()).toBeVisible({ timeout: 120_000 });

    const observed = await page.evaluate(() => ({
      isMobile: /Mobile|iPhone|Android/i.test(navigator.userAgent),
      hasTouch: navigator.maxTouchPoints > 0,
      deviceScaleFactor: window.devicePixelRatio,
      userAgent: navigator.userAgent,
    }));
    const expected = profileFor("mobile");
    const contextViewport = page.viewportSize();
    expect(contextViewport).toEqual(devices["iPhone 15 Pro"].viewport);
    expect(observed.deviceScaleFactor).toBe(devices["iPhone 15 Pro"].deviceScaleFactor);
    expect(observed.deviceScaleFactor).toBe(expected.deviceScaleFactor);
    expect(observed.isMobile).toBe(true);
    expect(observed.hasTouch).toBe(true);
    expect(observed.userAgent).toContain("iPhone");
    const viewportVerdict = viewportMatchesSurface("mobile", {
      ...contextViewport!,
      isMobile: observed.isMobile,
      hasTouch: observed.hasTouch,
    }, 0);
    expect(viewportVerdict.ok, viewportVerdict.reason).toBe(true);

    const current = await localTasks(token);
    const controller = current.find((task) => task.id === controllerId);
    expect(controller?.status).toBe("running");
    expect(controller?.model).toBe("gpt-5.6-sol");
    expect(controller?.reasoningEffort).toMatch(/^(low|medium|high|xhigh|max|ultra)$/);
    console.log("[task-sync-live] verifying restored controller owner focus");
    await assertOwningDeviceFocused(page, controller!.deviceName || "");
    console.log("[task-sync-live] verifying task metadata pixels and SSE");
    const modelLabel = page.getByText(`${controller!.model} · ${controller!.reasoningEffort}`, { exact: true }).first();
    await expect(modelLabel).toBeVisible({ timeout: 30_000 });
    const pixels = await modelLabel.screenshot();
    expect(pixels.byteLength).toBeGreaterThan(500);

    // Runner-backed sessions are ordinary Tasks on the overview. Hosting
    // implementation details and old attach/adopt actions stay out of it.
    await expect(page.getByText(/Yaver Sessions|Adopt Session|Attach Session|Yaver session ·|tmux/i)).toHaveCount(0);
    for (const title of fixtureTitles) await expect(page.getByText(title, { exact: true })).toHaveCount(0);

    // Opening the live controller proves the browser uses the same agent's
    // standard output SSE lane, not a dashboard substitute or mocked list.
    const outputRequest = page.waitForRequest((request) => {
      return request.method() === "GET" && normalizedTaskPath(request.url()) === `/tasks/${controllerId}/output`;
    }, { timeout: 30_000 });
    await page.getByText(controller!.title, { exact: true }).first().click();
    await expect(page.locator('[aria-label="Back to tasks list"]')).toBeVisible();
    await outputRequest;
    await page.locator('[aria-label="Back to tasks list"]').click();

    console.log("[task-sync-live] deleting only the two visible completed fixtures");
    await page.getByText(`Completed · ${fixtureIds.length}`, { exact: true }).click();
    for (const title of fixtureTitles) await expect(page.getByText(title, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Select tasks" }).click();
    await page.getByRole("button", { name: "Select all visible tasks" }).click();
    await expect(page.getByRole("button", { name: `Delete ${fixtureIds.length} selected tasks` })).toBeVisible();
    await page.getByRole("button", { name: `Delete ${fixtureIds.length} selected tasks` }).click();
    await expect(page.getByText("Completed · 0", { exact: true })).toBeVisible({ timeout: 30_000 });

    for (const taskId of fixtureIds) {
      await waitForLocalTask(token, taskId, null);
      await waitForSnapshotTask(convexURL, token, deviceId, taskId, null);
      expect(agentRequests).toContain(`DELETE /tasks/${taskId}`);
    }
    fixtureIds.length = 0;

    // Exercise virtual-list scroll plus a fresh mount: neither the local list
    // nor the Convex invalidation snapshot may resurrect deleted cache rows.
    await page.mouse.wheel(0, 700);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
    await expect(page.getByText("Connected", { exact: true }).first()).toBeVisible({ timeout: 120_000 });
    for (const title of fixtureTitles) await expect(page.getByText(title, { exact: true })).toHaveCount(0);
    expect((await localTasks(token)).find((task) => task.id === controllerId)?.status).toBe("running");
    await waitForSnapshotTask(convexURL, token, deviceId, controllerId, "running");

    expect(agentRequests.some((request) => request === "GET /tasks")).toBe(true);
    expect(agentRequests.some((request) => request === `GET /tasks/${controllerId}/output`)).toBe(true);
    console.log("[task-sync-live] local, UI, SSE, and Convex assertions converged");
  } finally {
    await context?.close();
    await browser?.close();
    for (const taskId of fixtureIds) {
      await deleteExactTask(token, controllerId, taskId).catch(() => undefined);
      await waitForLocalTask(token, taskId, null).catch(() => undefined);
      await waitForSnapshotTask(convexURL, token, deviceId, taskId, null).catch(() => undefined);
    }
  }
});
