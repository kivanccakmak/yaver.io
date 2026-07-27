// sessionExpiredNotice.test.mts — audit gap T6: a CONFIRMED session revoke
// must never be a silent logout. Web has named this since use-auth.ts gained
// `sessionExpired`; this pins the mobile side of the parity.
// Run: node --experimental-strip-types --test src/lib/sessionExpiredNotice.test.mts
//
// Structural on purpose: AuthContext and login.tsx are React trees this
// harness cannot mount, but the CONTRACT — both confirmed-invalid paths set
// the flag, user-initiated logout does not claim an expiry, and the login
// screen actually renders the sentence — is checkable from source. Proven by
// breaking: remove `setSessionExpired(true)` from either path and this fails.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SESSION_EXPIRED_NOTICE } from "./sessionExpiredNotice.ts";

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = join(mobileRoot, "..");
const authContext = readFileSync(join(mobileRoot, "src/context/AuthContext.tsx"), "utf8");
const loginScreen = readFileSync(join(mobileRoot, "app/login.tsx"), "utf8");

test("notice names the event and the action", () => {
  assert.match(SESSION_EXPIRED_NOTICE, /session expired/i);
  assert.match(SESSION_EXPIRED_NOTICE, /sign in again/i);
});

test("AuthContext sets sessionExpired on BOTH confirmed-invalid paths", () => {
  // Mount-restore: `invalidated` verdict clears the token AND names it.
  const restoreBlock = authContext.match(/if \(invalidated\) \{[\s\S]*?\}/);
  assert.ok(restoreBlock, "mount-restore invalidated block must exist");
  assert.match(restoreBlock![0], /setSessionExpired\(true\)/, "mount-restore logout must set sessionExpired");

  // notifyAuthFailure: validate-confirmed revoke.
  const confirmedBlock = authContext.match(/Token confirmed invalid[\s\S]{0,600}/);
  assert.ok(confirmedBlock, "confirmed-invalid block must exist");
  assert.match(confirmedBlock![0], /setSessionExpired\(true\)/, "confirmed revoke must set sessionExpired");
});

test("user-initiated logout and fresh login CLEAR the flag", () => {
  const setFalseCount = (authContext.match(/setSessionExpired\(false\)/g) || []).length;
  assert.ok(setFalseCount >= 2, "login and logout must both reset sessionExpired");
});

test("sessionExpired is part of the exported AuthState", () => {
  assert.match(authContext, /sessionExpired: boolean/);
  assert.match(authContext, /\bsessionExpired,/);
});

test("login screen renders the notice when sessionExpired", () => {
  assert.match(loginScreen, /SESSION_EXPIRED_NOTICE/);
  assert.match(loginScreen, /sessionExpired \?/);
});

test("parity: web dashboard names the same event", () => {
  const webAuth = readFileSync(join(repoRoot, "web/lib/use-auth.ts"), "utf8");
  assert.match(webAuth, /sessionExpired/);
});
