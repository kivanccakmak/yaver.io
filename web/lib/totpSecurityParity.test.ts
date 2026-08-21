/**
 * Cross-surface TOTP security contract.
 *
 * Run with:
 *   node --experimental-strip-types web/lib/totpSecurityParity.test.ts
 *
 * This is intentionally a wiring test. The recurring auth failure class in
 * Yaver is not a missing helper; it is one session-minting route forgetting to
 * call it. Break the OIDC gate, restore patch-then-throw, or hide enrollment
 * outside Settings and this test must fail.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const totp = read("backend/convex/totp.ts");
const httpOnDisk = read("backend/convex/http.ts");
// Failure-injection seam for proving the guard itself. This mutates only the
// in-memory test fixture; production files never move.
const oidcStartForInjection = httpOnDisk.indexOf('path: "/auth/oidc/callback"');
const http = process.env.YAVER_BREAK_TOTP_GUARD === "oidc"
  ? httpOnDisk.slice(0, oidcStartForInjection) +
    httpOnDisk.slice(oidcStartForInjection).replace(
      "internal.auth.getUserWithTotp",
      "internal.auth.__brokenTotpGate",
    )
  : httpOnDisk;
const schema = read("backend/convex/schema.ts");
const webSettings = read("web/components/dashboard/SettingsView.tsx");
const webDashboard = read("web/app/dashboard/page.tsx");
const webAuth = read("web/app/auth/page.tsx");
const mobileSettings = read("mobile/app/(tabs)/settings.tsx");
const mobileLogin = read("mobile/app/login.tsx");
const desktopLogin = read("desktop/app/src/renderer/index.html");
const tvosBackend = read("tvos/YaverTV/Backend.swift");
const androidTvBackend = read("androidtv/app/src/main/kotlin/io/yaver/tv/Backend.kt");
const watchSignIn = read("watch/YaverWatch/Views/SignInView.swift");
const wearSignIn = read("wear/app/src/main/kotlin/io/yaver/wear/ui/SignInScreen.kt");

test("2FA is opt-in and cannot become enabled during setup alone", () => {
  assert.match(schema, /totpEnabled:\s*v\.optional\(v\.boolean\(\)\)/);
  const setup = totp.slice(totp.indexOf("export const setupTotp"), totp.indexOf("export const verifyAndEnableTotp"));
  assert.ok(!setup.includes("totpEnabled: true"), "opening Settings must not silently enable 2FA");
  assert.match(webAuth, /setup2faAfterSignup,\s*setSetup2faAfterSignup\]\s*=\s*useState\(false\)/,
    "signup must not preselect optional 2FA enrollment");
  const enable = totp.slice(totp.indexOf("export const verifyAndEnableTotp"), totp.indexOf("export const disableTotp"));
  assert.ok(enable.includes("totpEnabled: true"), "verified enrollment no longer enables 2FA");
});

test("generic OIDC cannot bypass a TOTP-enabled account", () => {
  const start = http.indexOf("path: \"/auth/oidc/callback\"");
  const end = http.indexOf("function classifyWhatsappCommand", start);
  const callback = http.slice(start, end);
  const gate = callback.indexOf("internal.auth.getUserWithTotp");
  const mint = callback.indexOf("internal.auth.createSession");
  assert.ok(gate > 0 && callback.includes("internal.totp.createPendingAuth"), "OIDC has no TOTP challenge");
  assert.ok(mint > gate, "OIDC mints a session before checking TOTP");
});

test("failed attempts commit and are limited across replacement pending tokens", () => {
  const verify = totp.slice(totp.indexOf("export const verifyTotpForLogin"));
  assert.ok(verify.includes("auth-totp-user:"), "TOTP retries are not durably account-limited");
  assert.ok(verify.includes("await ctx.db.patch(pending._id, { attempts });"));
  assert.ok(verify.includes('return { ok: false as const, code: "INVALID_CODE" as const }'));
  assert.ok(!/patch\(pending\._id,[\s\S]{0,240}throw new Error\("INVALID_CODE"\)/.test(verify),
    "Convex rolls back patch-then-throw, making the attempt counter a false green");
});

test("abandoned challenges are bounded to one row per account", () => {
  const create = totp.slice(totp.indexOf("export const createPendingAuth"), totp.indexOf("export const verifyTotpForLogin"));
  const pendingSchema = schema.slice(schema.indexOf("pendingAuth: defineTable"), schema.indexOf("passkeys: defineTable"));
  assert.ok(pendingSchema.includes('.index("by_userId", ["userId"])'));
  assert.ok(create.includes('.withIndex("by_userId"'));
  assert.ok(create.includes("await ctx.db.delete(row._id)"));
});

test("TOTP is replay-resistant and new recovery codes carry 128 bits", () => {
  assert.ok(totp.includes("totpLastUsedStep"), "successful TOTP steps are not remembered");
  assert.match(totp, /matchedStep\s*<=\s*user\.totpLastUsedStep/);
  assert.ok(totp.includes("randomHex(16)"), "new recovery codes have less than 128 bits of source entropy");
});

test("account settings expose optional enrollment on web and mobile", () => {
  assert.ok(webSettings.includes("onOpenTwoFactor"));
  assert.ok(webDashboard.includes('setActiveTab("security")'));
  assert.ok(mobileSettings.includes('router.push("/two-factor-setup")'));
  for (const source of [webSettings, mobileSettings]) {
    assert.match(source, /Optional/);
    assert.match(source, /Microsoft Authenticator/);
    assert.match(source, /Google Authenticator/);
  }
});

test("direct-login clients challenge or route through trusted-device approval", () => {
  assert.ok(mobileLogin.includes("pendingToken: result.pendingToken"));
  assert.ok(desktopLogin.includes("window.yaver.verifyTotp"));
  assert.ok(desktopLogin.includes("Two-factor authentication (optional)"));
  assert.ok(tvosBackend.includes('obj?["requires2fa"] as? Bool == true'));
  assert.ok(androidTvBackend.includes('optBoolean("requires2fa")'));
  assert.match(tvosBackend, /Approve with the QR code above from your phone/);
  assert.match(watchSignIn, /device.code|device code|Device Code/i);
  assert.match(wearSignIn, /device-code flow/i);
});
