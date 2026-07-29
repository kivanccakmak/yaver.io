import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = join(process.cwd(), "web");

test("dashboard does not expose guest entry points when guest UI flag is off", () => {
  const page = readFileSync(join(root, "app/dashboard/page.tsx"), "utf8");

  assert.match(
    page,
    /if \(!ENABLE_GUEST_FEATURES \|\| !token\) \{ setPendingInvites\(\[\]\); return; \}/,
    "dashboard must not poll guest invitations while guest UI is disabled",
  );
  assert.match(
    page,
    /\{ENABLE_GUEST_FEATURES \? \(\s*<div>\s*<p[^>]*>Join as a guest<\/p>/s,
    "join-code UI must stay behind ENABLE_GUEST_FEATURES",
  );
  assert.match(
    page,
    /function isLaunchEnabledDashboardTab\(value: DashboardTab\): boolean \{\s*if \(value === "guests"\) return ENABLE_GUEST_FEATURES;/s,
    "guest tab deep links must be launch-gated like other hidden launch surfaces",
  );
  assert.match(
    page,
    /isDashboardTab\(tab\) && isLaunchEnabledDashboardTab\(tab\)/,
    "URL tab loader must ignore guest deep links while the flag is off",
  );
});
