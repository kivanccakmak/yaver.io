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
// EVERY RUN GETS ITS OWN OUTPUT DIRECTORY.
//
// Playwright CLEARS `test-results/` at the start of each run. With one shared
// directory, recording video/trace on pass is pointless theatre: the first
// green colour loop of the session recorded a 4.9 MB video.webm proving the
// preview really went black → red → black, and starting the mobile arc four
// minutes later deleted it. The evidence for a 25-minute run against a real
// box must outlive the next 25-minute run.
//
// Override with LOOP_RUN_ID to group several arcs under one folder (e.g. a
// web+mobile pair from the same session).
const runId = process.env.LOOP_RUN_ID || new Date().toISOString().replace(/[:.]/g, "-");

export default defineConfig({
  testDir: "./tests",
  outputDir: `./test-results/loops/${runId}`,
  // Keep artifacts for PASSING runs too — on a pixel verdict the footage is
  // the proof, not a debugging aid.
  preserveOutput: "always",
  testMatch: ["**/vibe-color-loop.spec.ts", "**/mobile-tab-navigation.spec.ts"],
  // A vibe turn is a real runner round trip plus a rebuild plus a reload.
  timeout: 45 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["line"]],
  use: {
    // ARTIFACTS ON EVERY RUN, PASS OR FAIL.
    //
    // These loops take 12-25 minutes and drive a real box, so a run you cannot
    // review is a run you have to repeat. "retain-on-failure" was exactly
    // wrong for a PIXEL verdict: the interesting evidence is what the preview
    // actually showed frame by frame, and on a PASS that footage is the proof
    // the colour really changed rather than the assertion being weak.
    // Recording both directions (black → red → black) also makes the revert
    // leg reviewable, which is the leg that has been failing.
    trace: "on",
    screenshot: "on",
    video: "on",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
