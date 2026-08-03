/**
 * playwright.device.config.ts — for arcs that drive a REAL device context
 * against a REAL box, with a REAL session token.
 *
 * The default e2e config exists for the web dashboard: it boots a Next.js web
 * server and a global-setup that provisions a dummy Convex user via
 * email/password. Neither applies here, and both are actively harmful:
 *
 *   • The web server is dead weight — these arcs drive the RN app served by
 *     `expo start`, on a different port, which the harness must not own.
 *   • The dummy user cannot even be created against the real deployment
 *     ("Email/password sign-in is not enabled for this email"), so every
 *     device arc failed in global-setup before its first line ran. That is a
 *     harness failure reported as a test failure — the exact false signal this
 *     suite exists to remove.
 *
 * These arcs authenticate with a token the caller supplies (YAVER_TEST_TOKEN)
 * for a box the caller names (VIBE_BOX_HOST). No fixtures, no provisioning.
 *
 * RUN:
 *   cd e2e && npx playwright test -c playwright.device.config.ts
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // Device arcs talk to one box and one dev server. Running them at once would
  // have them fight over the same preview session, which is a singleton.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: "line",
  timeout: 300_000,
  expect: { timeout: 30_000 },
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
