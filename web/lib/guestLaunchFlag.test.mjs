import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

// Anchored on THIS file, not process.cwd() — see codexModelDefaults.test.ts.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

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

test("web and mobile sanitize guest device state before it reaches v1 surfaces", () => {
  const useDevices = readFileSync(join(root, "lib/use-devices.ts"), "utf8");
  const mobileContext = readFileSync(join(repoRoot, "mobile/src/context/DeviceContext.tsx"), "utf8");

  assert.match(
    useDevices,
    /const arr = ENABLE_GUEST_FEATURES\s*\?\s*rawDevices\s*:\s*rawDevices\.filter\(\(d: any\) => !Boolean\(d\?\.isGuest\)\)/s,
    "web device hook must drop guest-owned rows while guest UI is disabled",
  );
  assert.match(
    useDevices,
    /sharedWithGuests: ENABLE_GUEST_FEATURES \? d\.sharedWithGuests : undefined,[\s\S]*sharedGuests: ENABLE_GUEST_FEATURES && Array\.isArray\(d\.sharedGuests\) \? d\.sharedGuests : undefined,[\s\S]*sharedProjects: ENABLE_GUEST_FEATURES && Array\.isArray\(d\.sharedProjects\) \? d\.sharedProjects : undefined,[\s\S]*sharedRunners: ENABLE_GUEST_FEATURES && Array\.isArray\(d\.sharedRunners\) \? d\.sharedRunners : undefined,/,
    "web device hook must strip host sharing metadata while guest UI is disabled",
  );
  assert.match(
    mobileContext,
    /const raw = ENABLE_GUEST_FEATURES \? rawAll : rawAll\.filter\(\(d: any\) => !Boolean\(d\?\.isGuest\)\)/,
    "mobile device context must drop guest-owned rows while guest UI is disabled",
  );
  assert.match(
    mobileContext,
    /if \(ENABLE_GUEST_FEATURES\) \{[\s\S]*fetchGuestHosts\(token\)[\s\S]*\} else \{\s*setGuestInvitations\(\[\]\);\s*setActiveHosts\(\[\]\);\s*\}/,
    "mobile must not fetch guest hosts while guest UI is disabled",
  );
});

test("public v1 docs do not advertise guest commands or guest access pages", () => {
  const files = [
    ["README", readFileSync(join(repoRoot, "README.md"), "utf8")],
    ["FAQ", readFileSync(join(root, "app/faq/page.tsx"), "utf8")],
    ["Developer docs", readFileSync(join(root, "app/docs/developers/page.tsx"), "utf8")],
  ];

  for (const [label, src] of files) {
    assert.doesNotMatch(src, /yaver guests/i, `${label} must not document guest CLI commands in v1`);
    assert.doesNotMatch(src, /Guest Access & Config/i, `${label} must not link a guest access doc surface in v1`);
    assert.doesNotMatch(src, /Can I share my own machine\?/i, `${label} must not advertise machine-sharing in v1`);
  }
});
