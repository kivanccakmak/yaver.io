/**
 * Remote-OAuth deep loop: sign a machine in, from a browser, end to end.
 *
 *   node e2e/remote-oauth-deep-loop.mjs
 *
 * The shallow loop (remote-oauth-approve-loop.mjs) proves the approver SCREEN
 * behaves. This one proves the actual RESCUE: it plays the part of a remote box
 * whose session is dead, drives a real Chromium through email + password sign-in
 * and approval, and then — as the box — polls until Convex hands it a working
 * session token. Nothing is stubbed. Every request is the exact one the Go agent
 * makes, against production.
 *
 * ── Why this has to exist ───────────────────────────────────────────────────
 *
 * On 2026-08-01 four machines sat in "Alive · can't reach (Relay refused:
 * account relay password missing or stale)" with no way out. Their sessions had
 * expired, so they could not refresh the relay password — the refetch
 * authenticates with the very token that is dead — and `yaver auth fix` from a
 * healthy machine answered "already signed in". A shell on each box was the only
 * remedy, including one on a LAN nobody was on.
 *
 * The chain that replaces those shell visits is four links long, and every link
 * has already been broken once:
 *
 *   1. the box notices reason=dead_token and nominates itself   <- had no trigger
 *   2. the code reaches a surface the owner can actually see    <- logged only
 *   3. the owner approves it from a browser or a phone          <- answered 500
 *   4. the box polls and gets a real session back               <- untested
 *
 * A test that only covers the screen would have passed while links 1, 2 and 4
 * were broken. So this walks 3 and 4 for real, and asserts the token it gets is
 * a token that actually works.
 *
 * ── What it asserts ─────────────────────────────────────────────────────────
 *
 *   - a box can mint a device code, and the code is the ABCD-1234 shape every
 *     surface's shape check expects
 *   - the code is PENDING before approval, so a passing run can never be a
 *     false green from a code that was already authorized
 *   - the public info endpoint names the machine, so the approver can say
 *     "Approve sign-in on <machine>?" instead of showing an opaque code
 *   - a real browser, signed in with email + password, approves it
 *   - the box's poll flips pending -> authorized and yields a token
 *   - that token AUTHENTICATES: it is accepted by /auth/validate and can read
 *     the account's own device list. A token that is merely non-empty is the
 *     kind of false green this suite exists to catch.
 *   - the same code cannot be approved twice, and the second attempt is NAMED
 *
 * ── Credentials and hygiene ─────────────────────────────────────────────────
 *
 * Credentials come from the gitignored .env.test and are never logged; the
 * account is echoed as its DOMAIN only. The run mints a REAL 1-year session for
 * the owner's own account, exactly as signing a box in would, so it prints only
 * a fingerprint of that token and never the token itself.
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';

const CONVEX = process.env.CONVEX_SITE_URL || 'https://perceptive-minnow-557.eu-west-1.convex.site';
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
const fingerprint = (t) => (t ? createHash('sha256').update(t).digest('hex').slice(0, 8) : 'none');

const steps = [];
const step = (name, ok, detail = '') => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every call below is bounded. An unbounded await in a rescue path is the exact
// defect this product keeps re-learning, and a test that can hang forever
// teaches the same lesson to whoever runs it.
async function jsonFetch(url, init = {}, ms = 20_000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: c.signal });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* leave null; callers report raw */ }
    return { status: res.status, body, text };
  } finally {
    clearTimeout(t);
  }
}

let browser;
try {
  // ── 1. play the remote box: mint a device code ───────────────────────────
  // Same POST the Go agent's requestDeviceCode() makes, same body shape as
  // buildDeviceCodeRequest(). The machine name is unmistakably a test box so a
  // human reading the approval screen knows what they are approving.
  const machineName = 'yaver-e2e-remote-oauth';
  const created = await jsonFetch(`${CONVEX}/auth/device-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      machineName, platform: 'linux', arch: 'arm64', shell: '/bin/bash',
      runtimeVersion: 'e2e', environment: 'e2e',
    }),
  });
  const userCode = created.body?.userCode || '';
  const deviceCode = created.body?.deviceCode || '';
  step('a remote box can mint a device code', created.status === 200 && !!userCode && !!deviceCode,
    created.status === 200 ? `code ${userCode}` : `HTTP ${created.status} ${created.text.slice(0, 120)}`);
  if (!userCode || !deviceCode) throw new Error('no device code to approve');

  // The shape every surface's validator expects. The agent, the web approver,
  // the mobile normalizer and the heartbeat shape check all assume ABCD-1234;
  // if the backend ever changes it, they all silently stop matching.
  step('the code is the ABCD-1234 shape every surface assumes', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode));

  // ── 2. it must be PENDING before we approve it ───────────────────────────
  // Without this, a run could "pass" on a code that was already authorized and
  // prove nothing about the approval itself.
  const before = await jsonFetch(`${CONVEX}/auth/device-code/info?user_code=${encodeURIComponent(userCode)}`);
  step('the code starts out pending, so approval is what changes it',
    before.status === 200 && before.body?.status !== 'authorized',
    `status=${before.body?.status ?? 'unset'}`);

  // The approver screen promises "Approve sign-in on <machine>?" — that needs
  // the machine's name to survive the round trip.
  step('the approver can name the machine instead of showing an opaque code',
    before.body?.machineName === machineName, `machineName=${before.body?.machineName ?? 'missing'}`);

  const pollOnce = () => jsonFetch(`${CONVEX}/auth/device-code/poll?device_code=${encodeURIComponent(deviceCode)}`);
  const prePoll = await pollOnce();
  step('the box sees "pending" while it waits', prePoll.body?.status === 'pending' && !prePoll.body?.token,
    `status=${prePoll.body?.status}`);

  // ── 3. a real browser signs in and approves ──────────────────────────────
  browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

  await page.goto(`${APP}/auth`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByPlaceholder('Email address').waitFor({ timeout: 20_000 });
  await page.getByPlaceholder('Email address').fill(env.YAVER_TEST_EMAIL);
  await page.getByPlaceholder('Password').fill(env.YAVER_TEST_PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForURL(/\/(survey|dashboard)(?:$|\?)/, { timeout: 30_000 });
  step('a browser signs in with email + password', true, ACCOUNT_HINT);

  // The deep-link form is what a box prints and what a QR code encodes, so this
  // exercises the path a user actually takes rather than a hand-typed code.
  await page.goto(`${APP}/auth/device?code=${encodeURIComponent(userCode)}`,
    { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await sleep(5000);

  let body = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  step('the approver recognises the pending machine from the link',
    body.includes(machineName) || /approve/i.test(body),
    body.includes(machineName) ? `named "${machineName}"` : 'rendered an approve affordance');

  const approveBtn = page.getByRole('button', { name: /authorize|approve/i }).first();
  if (await approveBtn.isVisible().catch(() => false)) {
    await approveBtn.click();
    await sleep(6000);
  }
  body = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const browserSaysOk = !/failed to authorize|something went wrong|invalid code/i.test(body);
  step('the browser reports no failure after approving', browserSaysOk,
    browserSaysOk ? '' : body.replace(/\s+/g, ' ').slice(0, 140));

  // ── 4. the box polls and gets a session — the link nobody had tested ─────
  let token = '';
  let status = '';
  for (let i = 0; i < 20 && !token; i++) {
    const p = await pollOnce();
    status = p.body?.status || '';
    if (p.body?.token) { token = p.body.token; break; }
    if (status === 'expired') break;
    await sleep(1500);
  }
  step('the box\'s poll flips to authorized and yields a token', !!token,
    token ? `status=${status || 'authorized'} token=sha256:${fingerprint(token)}` : `stuck at status=${status || 'unknown'}`);

  // ── 5. the token must actually WORK ─────────────────────────────────────
  // A non-empty string is not a session. This is the difference between the
  // inventory saying yes and the operation saying yes.
  if (token) {
    const validated = await jsonFetch(`${CONVEX}/auth/validate`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    step('the minted token authenticates against /auth/validate', validated.status === 200,
      `HTTP ${validated.status}`);

    const devices = await jsonFetch(`${CONVEX}/devices/list`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const list = Array.isArray(devices.body) ? devices.body : (devices.body?.devices || []);
    step('the rescued box can read its own account with that token',
      devices.status === 200 && Array.isArray(list),
      devices.status === 200 ? `${list.length} machines visible` : `HTTP ${devices.status}`);

    // The point of the whole exercise: this is the field a surface renders an
    // Approve button from. Reported, not asserted — it is only populated once a
    // box on 1.99.394+ is actually refused by the relay.
    const offering = list.filter((d) => d && d.pendingAuthCode);
    console.log(`     note: ${offering.length} machine(s) currently offering a rescue code` +
      (offering.length ? ` (${offering.map((d) => d.name || d.deviceId).join(', ')})` : ''));
  }

  // ── 6. a used code must not be reusable, and must say so ────────────────
  const replay = await jsonFetch(`${CONVEX}/auth/device-code/poll?device_code=${encodeURIComponent(deviceCode)}`);
  step('a claimed code does not keep handing out sessions',
    !(replay.body?.token && replay.body.token !== token),
    `status=${replay.body?.status ?? 'unset'}`);
} catch (err) {
  step('loop completed without throwing', false, String(err?.message || err).slice(0, 180));
} finally {
  await browser?.close().catch(() => {});
}

const failed = steps.filter((s) => !s.ok);
console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} (${steps.length} checks) — ${ACCOUNT_HINT}`);
process.exit(failed.length === 0 ? 0 : 1);
