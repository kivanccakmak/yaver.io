import { expect, test } from "@playwright/test";

const TARGET_DEVICE_NAME = "ubuntu-4gb-hel1-1";
function agentCorsHeadersFor(pageUrl: string) {
  const origin = new URL(pageUrl).origin;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Relay-Password",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

async function installDashboardRoutes(page: import("@playwright/test").Page) {
  if (process.env.E2E_LOG_AGENT === "1") {
    page.on("console", (message) => console.log(`[dashboard-v1-devices:browser] ${message.type()} ${message.text()}`));
  }
  const now = Date.now();
  const stalePrimaryDevice = {
    deviceId: "linux-real",
    name: TARGET_DEVICE_NAME,
    alias: "linux",
    platform: "linux",
    host: "127.0.0.1",
    port: 19080,
    isOnline: false,
    lastHeartbeat: now - 1000 * 60 * 60,
    needsAuth: false,
    agentVersion: "1.99.389",
    deviceClass: "dedicated",
    publicEndpoints: [],
    sharedWithGuests: true,
    sharedGuests: [{ name: "Serhat Fatih Uzun", email: "serhat@example.test" }],
    runners: [
      { id: "codex", name: "Codex", installed: true, authenticated: true, preferred: true },
    ],
  };
  const onlineDuplicate = {
    deviceId: "linux-duplicate-auth",
    name: TARGET_DEVICE_NAME,
    alias: "linux-3",
    platform: "linux",
    host: "127.0.0.1",
    port: 18080,
    isOnline: true,
    lastHeartbeat: now,
    needsAuth: false,
    agentVersion: "1.99.259",
    deviceClass: "dedicated",
    publicEndpoints: [],
    sharedWithGuests: true,
    sharedGuests: [{ name: "Serhat Fatih Uzun", email: "serhat@example.test" }],
    runners: [],
  };

  await page.addInitScript(() => {
    window.localStorage.setItem("yaver_auth_token", "mock-token");
  });

  await page.route("**/*", async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const parsed = new URL(url);
    const path = parsed.pathname;
    const agentCorsHeaders = agentCorsHeadersFor(page.url());
    if (process.env.E2E_LOG_AGENT === "1" && parsed.host.includes("18080")) {
      console.log(`[dashboard-v1-devices] ${method} ${url}`);
    }

    if (parsed.host === "127.0.0.1:18080" && method === "OPTIONS") {
      await route.fulfill({ status: 204, headers: agentCorsHeaders });
      return;
    }

    if (path === "/auth/validate") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: { userId: "owner-1", email: "owner@yaver.test", fullName: "Owner" },
        }),
      });
      return;
    }

    if (path === "/devices/list") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ devices: [stalePrimaryDevice, onlineDuplicate] }),
      });
      return;
    }

    if (path === "/settings") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          settings: {
            primaryDeviceId: "linux-real",
            machineRolesByProject: [{ runnerDeviceId: "linux-real", renderDeviceId: "linux-real" }],
          },
        }),
      });
      return;
    }

    if (path === "/config") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ relayServers: [] }) });
      return;
    }

    if (path === "/devices/pending-list" || path === "/subscription" || path === "/tasks") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, tasks: [] }) });
      return;
    }

    if (parsed.host === "127.0.0.1:18080" && path === "/health") {
      await route.fulfill({
        status: 200,
        headers: agentCorsHeaders,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
      return;
    }

    if (parsed.host === "127.0.0.1:18080" && path === "/info") {
      await route.fulfill({
        status: 200,
        headers: agentCorsHeaders,
        contentType: "application/json",
        body: JSON.stringify({
          hostname: TARGET_DEVICE_NAME,
          version: "1.99.389",
          workDir: "/home/yaver/workspace",
        }),
      });
      return;
    }

    if (parsed.host === "127.0.0.1:18080" && path === "/agent/runners") {
      await route.fulfill({
        status: 200,
        headers: agentCorsHeaders,
        contentType: "application/json",
        body: JSON.stringify([{ id: "codex", name: "Codex", installed: true, authenticated: true, isDefault: true }]),
      });
      return;
    }

    if (parsed.host === "127.0.0.1:18080") {
      await route.fulfill({
        status: 200,
        headers: agentCorsHeaders,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, count: 0, projects: [], tasks: [], sessions: [], peers: [], target: null }),
      });
      return;
    }

    if (parsed.host.endsWith("convex.site")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      return;
    }

    await route.continue();
  });
}

test.describe("v1 devices dashboard", () => {
  test("keeps guests closed and collapses duplicate auth rows to the real Ubuntu row", async ({ page }) => {
    await installDashboardRoutes(page);

    await page.goto("/dashboard?tab=devices");

    const main = page.locator("main, [role=main], .dashboard-main").first();
    await expect(page.getByText("Join as a guest")).toHaveCount(0);
    await expect(page.getByText(/invite a guest/i)).toHaveCount(0);
    await expect(page.getByText(/shared with/i)).toHaveCount(0);
    await expect(page.getByText("Serhat Fatih Uzun")).toHaveCount(0);
    await expect(main.getByRole("heading", { name: TARGET_DEVICE_NAME })).toHaveCount(1);
    await expect(main.getByText("@linux-3", { exact: true })).toHaveCount(1);
    await expect(page.getByText("@linux", { exact: true })).toHaveCount(0);
  });

  test("does not deep-link into the guest surface while guest access is launch-disabled", async ({ page }) => {
    await installDashboardRoutes(page);

    await page.goto("/dashboard?tab=guests");

    await expect(page.getByText("Join as a guest")).toHaveCount(0);
    await expect(page.getByText(/guest sharing|shared with guests|invite a guest/i)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: TARGET_DEVICE_NAME })).toBeVisible();
  });
});
