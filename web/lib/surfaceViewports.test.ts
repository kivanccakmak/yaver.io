/**
 * Guards for surfaceViewports.
 *
 * The bug these exist for: a closed loop narrowed a desktop Chrome window to
 * 390px and called itself "mobile RN-web". Narrowing is not emulation, and a
 * green result there says nothing about the app a user holds.
 *
 * Run: npx tsx web/lib/surfaceViewports.test.ts
 */
import { SURFACE_PROFILES, profileFor, viewportMatchesSurface } from "./surfaceViewports";

let failures = 0;
const eq = (got: unknown, want: unknown, label: string) => {
  if (got === want) console.log(`ok   ${label}`);
  else { console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); failures++; }
};
const ok = (c: unknown, label: string) => eq(Boolean(c), true, label);

// ── every surface states its geometry and its reason ─────────────────────
for (const [name, p] of Object.entries(SURFACE_PROFILES)) {
  ok(p.width > 0 && p.height > 0, `${name} has real geometry`);
  ok(p.why.length > 30, `${name} explains WHY, so a reader can check it rather than trust it`);
}

// ── THE BUG: a narrowed desktop is not a phone ───────────────────────────
const narrowedDesktop = { width: 393, height: 659, isMobile: false, hasTouch: false };
const r = viewportMatchesSurface("mobile", narrowedDesktop);
eq(r.ok, false, "a narrowed DESKTOP browser is rejected as mobile even at the exact phone size");
ok(/narrowed desktop browser is not a phone/i.test(r.reason),
  "…and the reason says exactly why, since the width alone looked right");

const realPhone = { width: 393, height: 659, isMobile: true, hasTouch: true };
ok(viewportMatchesSurface("mobile", realPhone).ok, "genuine phone emulation passes");

// Touch matters independently: RN-web renders a different tree without it.
eq(viewportMatchesSurface("mobile", { ...realPhone, hasTouch: false }).ok, false,
  "no touch = not mobile, whatever the size says");

// ── phone vs tablet must not be interchangeable ──────────────────────────
eq(viewportMatchesSurface("tablet", realPhone).ok, false,
  "a phone profile is NOT a tablet — login.tsx gates real layout on isTablet");
ok(viewportMatchesSurface("tablet", { width: 810, height: 1080, isMobile: true, hasTouch: true }).ok,
  "the tablet profile passes as tablet");

// ── desktop ──────────────────────────────────────────────────────────────
ok(viewportMatchesSurface("web", { width: 1600, height: 1100, isMobile: false, hasTouch: false }).ok,
  "the dashboard profile passes as web");
eq(viewportMatchesSurface("web", { width: 900, height: 700, isMobile: false, hasTouch: false }).ok, false,
  "a narrow window is NOT the dashboard — the Vibing panes stack and the loop drives a different UI");

// ── tolerance is for chrome, not for a device class ──────────────────────
ok(viewportMatchesSurface("mobile", { width: 393 - 20, height: 659 - 20, isMobile: true, hasTouch: true }).ok,
  "small deltas (browser chrome) are tolerated");
eq(viewportMatchesSurface("mobile", { width: 393 - 200, height: 659, isMobile: true, hasTouch: true }).ok, false,
  "a large delta is a different device, not chrome");

// ── watch is short as well as narrow ─────────────────────────────────────
eq(viewportMatchesSurface("watch", realPhone).ok, false,
  "a phone is not a watch — the watch's main failure mode is VERTICAL crowding, which a tall phone hides");

eq(profileFor("mobile").playwrightDevice, "iPhone 15", "mobile maps to a real Playwright device descriptor");
// The DESCRIPTOR is the source of truth, not a spec sheet. Playwright's iPhone
// viewport is the VISIBLE area (Safari chrome excluded) — 659, not the 852
// physical screen height. Guessing the latter made the guard reject genuine
// iPhone emulation on its first real run.
eq(profileFor("mobile").height, 659,
  "mobile height is the descriptor's VISIBLE viewport, which is what window.innerHeight reports");
eq(profileFor("tv").playwrightDevice, null, "tv has no browser descriptor — it is a separate native app");

if (failures) { console.error(`\nsurfaceViewports: ${failures} FAILED`); process.exitCode = 1; }
else console.log("\nsurfaceViewports: ALL PASS");
