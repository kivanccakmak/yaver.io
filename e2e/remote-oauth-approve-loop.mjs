/**
 * Remote-OAuth approve loop: can a signed-in surface rescue a box it cannot reach?
 *
 *   node e2e/remote-oauth-approve-loop.mjs
 *
 * This is the last mile of the recovery chain shipped 2026-08-01. Four machines
 * sat in "Alive · can't reach (Relay refused: account relay password missing or
 * stale)" with no way out: the session had expired, so the box could not refresh
 * its relay password (the refetch authenticates with the very token that is
 * dead), and `yaver auth fix` answered "already signed in" because markBootstrap
 * could not flag needsAuth. A shell on each box was the only remedy — including
 * one on a LAN nobody was on.
 *
 * The chain now runs: requestAgentUpdate (desired state, needs no reachability)
 * → box pulls 1.99.394 over outbound HTTPS → box SELF-NOMINATES a device code on
 * reason=dead_token → an already-signed-in surface approves it → fresh session →
 * relay accepts.
 *
 * Step four is the one a browser can prove, and it is the one that must never
 * rot: if the approver stops rendering, every unreachable box in the fleet
 * becomes a shell visit again.
 *
 * ── What it asserts, and what it deliberately does not ──────────────────────
 *
 * It does NOT require a live pending code. Whether a box happens to be
 * nominating itself right now depends on which machines are broken this hour,
 * and a test that only passes while the fleet is damaged is a test nobody can
 * run. Instead it proves the SURFACE: the approver loads for a signed-in user,
 * takes a code, and NAMES a bad one instead of failing silently — the same
 * SILENT-is-the-only-failure rule the rest of this suite uses.
 *
 * ── Credentials ────────────────────────────────────────────────────────────
 *
 * From the gitignored .env.test, never inlined and never logged. The account is
 * echoed as its DOMAIN only, so a CI log or a pasted terminal never carries the
 * address. Keep that property if you add assertions.
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'fs';

const APP = process.env.WEB_URL || 'https://yaver.io';
const ENV_PATH = process.env.YAVER_ENV_FILE || '/Users/kivanccakmak/Workspace/yaver.io/.env.test';

const env = Object.fromEntries(
  readFileSync(ENV_PATH, 'utf8')
    .split('\n').filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
if (!env.YAVER_TEST_EMAIL || !env.YAVER_TEST_PASSWORD) {
  console.error(`FAIL: credentials missing from ${ENV_PATH}`);
  process.exit(2);
}
const ACCOUNT_HINT = `<redacted>@${String(env.YAVER_TEST_EMAIL).split('@')[1] || 'unknown'}`;

const steps = [];
const step = (name, ok, detail = '') => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = () => page.evaluate(() => document.body?.innerText || '').catch(() => '');

try {
  // Selectors mirror e2e/helpers/login.ts so both break together.
  await page.goto(`${APP}/auth`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByPlaceholder('Email address').waitFor({ timeout: 20_000 });
  await page.getByPlaceholder('Email address').fill(env.YAVER_TEST_EMAIL);
  await page.getByPlaceholder('Password').fill(env.YAVER_TEST_PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForURL(/\/(survey|dashboard)(?:$|\?)/, { timeout: 30_000 });
  step('signs in with email + password', true, ACCOUNT_HINT);

  // ── the approver must exist for a signed-in user ─────────────────────────
  await page.goto(`${APP}/auth/device`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await sleep(4000);
  let body = await text();

  const rendered = !/404|not found/i.test(body) && body.trim().length > 0;
  step('the device approver renders for a signed-in user', rendered);

  // It must take a code. Without an input there is no rescue path at all.
  const inputs = await page.evaluate(() =>
    [...document.querySelectorAll('input')].map((i) => i.placeholder || i.name || i.type),
  );
  step('it accepts a device code', inputs.length > 0, inputs.length ? inputs.join(', ') : 'NO INPUT — the rescue path is unreachable');

  // ── a bad code must be NAMED, never silent ───────────────────────────────
  if (inputs.length > 0) {
    await page.locator('input').first().fill('ZZZZ-0000');
    const submit = page.getByRole('button', { name: /approve|continue|sign in|authorize/i }).first();
    if (await submit.isVisible().catch(() => false)) await submit.click();
    await sleep(5000);
    body = await text();
    const named = /invalid|expired|not found|incorrect|couldn|check the code/i.test(body);
    step('an invalid code is named, not silent', named,
      named ? 'cause stated' : 'SILENT — the user cannot tell a typo from an outage');
  }

  // The approver must never leak how to bypass approval: no token in the URL.
  step('no session token rides the URL', !/token=|auth_token=/i.test(page.url()));
} catch (err) {
  step('loop completed without throwing', false, String(err.message).slice(0, 160));
} finally {
  await ctx.close().catch(() => {});
  await browser.close().catch(() => {});
}

const failed = steps.filter((s) => !s.ok);
console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} (${steps.length} checks) — ${ACCOUNT_HINT}`);
process.exit(failed.length === 0 ? 0 : 1);
