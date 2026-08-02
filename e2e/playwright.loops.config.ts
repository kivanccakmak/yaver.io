import { defineConfig, devices } from "@playwright/test";

/**
 * Config for the live closed loops (vibe colour, connectivity, model select).
 *
 * SEPARATE from playwright.config.ts on purpose. That config runs a global
 * setup which provisions a dummy email/password user — and email/password
 * signup is gated on this deployment, so it throws 403 before any spec runs.
 * These loops authenticate as the REAL owner account instead (that is the
 * point of them), so they must not be blocked by a fixture they never use.
 *
 * No webServer either: they drive PRODUCTION, not a local build.
 *
 *   npx playwright test -c playwright.loops.config.ts
 *   MCP: testkit_run {dir: "e2e", config: "playwright.loops.config.ts"}
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: ["**/vibe-color-loop.spec.ts", "**/mobile-tab-navigation.spec.ts"],
  // A vibe turn is a real runner round trip plus a rebuild plus a reload.
  timeout: 45 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["line"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
