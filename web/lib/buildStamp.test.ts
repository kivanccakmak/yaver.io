/**
 * The build stamp must be set BY THE DEPLOY, and the dashboard must render it.
 *
 * Guarding both halves matters: a stamp nothing sets is always "dev" (so it
 * still cannot distinguish a stale tab from an unshipped fix), and a stamp
 * nothing renders is invisible. Either half missing recreates the 2026-07-28
 * incident described in buildStamp.ts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BUILD_ID, BUILD_IS_UNSTAMPED, buildLabel } from "./buildStamp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("an unstamped build says 'dev' — never a plausible-looking lie", () => {
  // No NEXT_PUBLIC_BUILD_ID in this test process, so this is the real default.
  assert.equal(BUILD_ID, "dev");
  assert.equal(BUILD_IS_UNSTAMPED, true);
});

test("buildLabel puts the semver and the build id in one shape", () => {
  assert.equal(buildLabel("1.1.162"), "v1.1.162 · dev");
});

/**
 * Comments are not code. Matching the raw file passed even with the export
 * commented out — the regex found the words inside this file's own explanatory
 * comment. Strip comment lines first, or the guard is a false green (found by
 * breaking it, 2026-07-28).
 */
function executableLines(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

test("deploy-web.sh exports NEXT_PUBLIC_BUILD_ID from the git SHA before building", () => {
  const sh = executableLines(readFileSync(join(root, "../scripts/deploy-web.sh"), "utf8"));
  assert.match(
    sh,
    /NEXT_PUBLIC_BUILD_ID="\$\(git -C "\$REPO_ROOT" rev-parse --short HEAD/,
    "deploy-web.sh must derive the build id from the deployed git SHA",
  );
  assert.match(sh, /export NEXT_PUBLIC_BUILD_ID/, "the build id must be exported so Next inlines it");

  // It has to be exported BEFORE `npm run deploy`, or the build never sees it.
  const exportAt = sh.indexOf("export NEXT_PUBLIC_BUILD_ID");
  const buildAt = sh.indexOf("npm run deploy");
  assert.ok(exportAt > -1 && buildAt > -1, "both the export and the build step must exist");
  assert.ok(exportAt < buildAt, "NEXT_PUBLIC_BUILD_ID must be exported before the build runs");

  // The script must reference a variable that actually exists in it, or the
  // stamp silently becomes "unknown" on every deploy.
  assert.ok(sh.includes('REPO_ROOT="'), "deploy-web.sh must define REPO_ROOT (the git -C target)");
});

test("the dashboard renders the build label, not the bare semver", () => {
  const page = readFileSync(join(root, "app/dashboard/page.tsx"), "utf8");
  assert.match(page, /buildLabel\(WEB_VERSION\)/, "page.tsx must build its label via buildLabel");
  assert.match(page, /\{WEB_BUILD_LABEL\}/, "the sidebar must render the stamped label");
  assert.doesNotMatch(
    page,
    /\bv\{WEB_VERSION\}/,
    "the sidebar must not print the hand-maintained semver alone — it does not move on deploy",
  );
});
