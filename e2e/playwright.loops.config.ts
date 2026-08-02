import { defineConfig, devices } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Load `.env.test` before the specs decide whether to skip.
 *
 * WHY THIS IS HERE. `creds()` in vibe-color-loop.spec.ts reads
 * process.env.YAVER_TEST_EMAIL directly, and nothing in this config used to
 * populate it. Running the suite from a git WORKTREE — where `.env.test` is
 * gitignored and therefore absent — produced `1 skipped` and **exit code 0**.
 * A closed loop that never ran, reporting success, is precisely the false
 * green this suite exists to prevent, reproduced in its own harness.
 *
 * The skip itself stays correct: a missing credential is an environment gap,
 * not a product defect, and turning it into a red would be a false red. The
 * fix is to stop manufacturing the gap when the file is right there.
 *
 * Searched upward so a worktree finds the checkout's copy via a symlink, and
 * NEVER overrides a variable already exported — an explicit env always wins.
 *
 * Walked from process.cwd() rather than import.meta.url: Playwright loads this
 * config through a CommonJS transform, where import.meta is a syntax error at
 * load time ("exports is not defined") that takes the whole run down before a
 * single spec is collected.
 */
for (let dir = resolve(process.cwd()), i = 0; i < 4; i++, dir = dirname(dir)) {
  const file = join(dir, ".env.test");
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0 || line.trimStart().startsWith("#")) continue;
    const key = line.slice(0, eq).trim();
    if (!process.env[key]) process.env[key] = line.slice(eq + 1).trim();
  }
  break;
}

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
