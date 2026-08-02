/**
 * Fleet rescue loop: bring every stranded machine back, from a browser.
 *
 *   node e2e/fleet-rescue-loop.mjs            # report only
 *   node e2e/fleet-rescue-loop.mjs --apply    # queue updates + approve codes
 *
 * This is the operator's half of the remote-OAuth chain. remote-oauth-deep-loop
 * proves the mechanism works on a synthetic box; this one points the mechanism
 * at the REAL fleet, signs in with email + password in Chromium, and drives the
 * two levers that need no reachability whatsoever:
 *
 *   1. QUEUE AN UPDATE. requestAgentUpdate writes desired state to Convex. The
 *      box pulls it over outbound HTTPS on its own schedule — no relay, no
 *      inbound port, no working session. This is how a machine that nothing can
 *      reach still gets the build that knows how to ask for help.
 *   2. APPROVE A RESCUE CODE. A box on 1.99.395+ that the relay refuses with
 *      reason=dead_token mints a device code and publishes it on its heartbeat.
 *      Approving it here mints a fresh session; the box's own poller picks it up
 *      within about five seconds.
 *
 * Both levers are outbound-only by design, which is the entire point: on
 * 2026-08-01 four machines sat in "Alive · can't reach (Relay refused: account
 * relay password missing or stale)" and the only remedy was a shell on each one,
 * including a box on a LAN nobody was on.
 *
 * ── Why it reads the fleet through the browser ──────────────────────────────
 *
 * Not for authenticity theatre — because the local CLI token on this Mac lists
 * ZERO machines while a browser session for the same person lists six. Whatever
 * the cause, an operator tool that silently reports an empty fleet is worse than
 * one that refuses to run, so this takes the session that demonstrably sees the
 * machines.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 *
 * Read-only unless --apply is passed. Queuing an update is reversible and
 * idempotent (desired state, not a command). Approving a code only ever signs a
 * machine into the account that is ALREADY signed in here. Nothing is deleted,
 * nothing is rebooted, and no machine outside this account is touched.
 *
 * Credentials come from the gitignored .env.test, are never logged, and the
 * account is echoed as its domain only.
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'fs';

const CONVEX = process.env.CONVEX_SITE_URL || 'https://perceptive-minnow-557.eu-west-1.convex.site';
const APP = process.env.WEB_URL || 'https://yaver.io';
const ENV_PATH = process.env.YAVER_ENV_FILE || '/Users/kivanccakmak/Workspace/yaver.io/.env.test';
// "latest", not a pin, and that is not a shortcut — it is the only value the
// agent will act on. claimAndApplyAgentUpdateRequest refuses anything else
// outright ("this agent can only track `latest`"), and it refuses AFTER
// ClaimAgentUpdateRequest has already cleared desiredAgentVersion — so a pinned
// request is consumed and discarded, the surface is told {ok:true}, and nothing
// ever reports that the update evaporated. Measured 2026-08-01: six machines
// queued for 1.99.395, all six silently unchanged 12 minutes later.
// TARGET_VERSION below is only used to decide WHICH boxes are stale.
const QUEUE_VERSION = process.env.YAVER_QUEUE_VERSION || 'latest';
const TARGET_VERSION = process.env.YAVER_TARGET_VERSION || '1.99.395';
const APPLY = process.argv.includes('--apply');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(token, path, init = {}, ms = 20_000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const res = await fetch(`${CONVEX}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
      signal: c.signal,
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* report raw */ }
    return { status: res.status, body, text };
  } catch (e) {
    return { status: 0, body: null, text: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

const cmp = (a, b) => {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

let browser;
let exitCode = 0;
try {
  browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(`${APP}/auth`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByPlaceholder('Email address').waitFor({ timeout: 20_000 });
  await page.getByPlaceholder('Email address').fill(env.YAVER_TEST_EMAIL);
  await page.getByPlaceholder('Password').fill(env.YAVER_TEST_PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForURL(/\/(survey|dashboard)(?:$|\?)/, { timeout: 30_000 });
  const token = await page.evaluate(() => localStorage.getItem('yaver_auth_token'));
  if (!token) throw new Error('signed in but no session token in this browser');
  console.log(`signed in as ${ACCOUNT_HINT}${APPLY ? '  [APPLY]' : '  [report only]'}\n`);

  const listed = await api(token, '/devices/list');
  const devices = Array.isArray(listed.body) ? listed.body : (listed.body?.devices || []);
  if (!devices.length) {
    console.log('no machines on this account — nothing to rescue');
    process.exit(0);
  }

  const now = Date.now();
  const rows = devices.map((d) => {
    const id = d.deviceId || d._id || '';
    const last = d.lastSeen || d.lastHeartbeat || 0;
    return {
      id,
      name: d.alias || d.name || d.hostname || id.slice(0, 8),
      version: d.agentVersion || '',
      online: !!d.online,
      ageMin: last ? Math.round((now - last) / 60000) : -1,
      code: d.pendingAuthCode || '',
      needsAuth: !!d.needsAuth,
    };
  });

  console.log(`${rows.length} machines\n`);
  for (const r of rows) {
    const stale = r.version && cmp(r.version, TARGET_VERSION) < 0;
    const flags = [
      r.online ? 'online' : 'offline',
      r.ageMin >= 0 ? `last ${r.ageMin}m` : 'never seen',
      r.version ? `v${r.version}${stale ? ' (stale)' : ''}` : 'version unknown',
      r.code ? `OFFERING ${r.code}` : '',
      r.needsAuth ? 'needsAuth' : '',
    ].filter(Boolean);
    console.log(`  ${r.name.padEnd(22)} ${flags.join(' · ')}`);
  }
  console.log('');

  // ── lever 1: queue the build that knows how to ask for help ──────────────
  const stale = rows.filter((r) => !r.version || cmp(r.version, TARGET_VERSION) < 0);
  if (!stale.length) {
    console.log(`every machine already reports ${TARGET_VERSION} or newer`);
  } else if (!APPLY) {
    console.log(`would queue ${QUEUE_VERSION} for ${stale.length}: ${stale.map((r) => r.name).join(', ')}`);
  } else {
    for (const r of stale) {
      const res = await api(token, '/devices/request-update', {
        method: 'POST',
        body: JSON.stringify({ deviceId: r.id, version: QUEUE_VERSION }),
      });
      const ok = res.status === 200 && res.body?.ok !== false;
      console.log(`  ${ok ? 'queued  ' : 'FAILED  '} ${r.name.padEnd(22)} -> ${QUEUE_VERSION}` +
        (ok ? '' : `  (HTTP ${res.status} ${String(res.text).slice(0, 90)})`));
      if (!ok) exitCode = 1;
    }
    console.log('\n  queued as DESIRED STATE — each box pulls it over outbound HTTPS on its own\n' +
      '  schedule, so this works on machines nothing can currently reach.');
  }
  console.log('');

  // ── lever 2: approve any rescue code on offer ────────────────────────────
  const offering = rows.filter((r) => r.code);
  if (!offering.length) {
    console.log('no machine is offering a rescue code right now.');
    console.log('a box only mints one after it runs 1.99.395+ AND the relay refuses it with');
    console.log('reason=dead_token — so this stays empty until the queued updates land.');
  } else if (!APPLY) {
    console.log(`would approve ${offering.length}: ${offering.map((r) => `${r.name} (${r.code})`).join(', ')}`);
  } else {
    for (const r of offering) {
      const res = await api(token, '/auth/device-code/authorize', {
        method: 'POST',
        body: JSON.stringify({ userCode: r.code, convexUrl: CONVEX }),
      });
      if (res.status === 200) {
        console.log(`  RESCUED  ${r.name} — it picks up the new session within ~5s`);
      } else {
        // The backend now names its failures instead of answering 500 for
        // everything, so this line is worth reading.
        console.log(`  FAILED   ${r.name} — ${res.body?.code || res.status}: ${res.body?.error || res.text.slice(0, 90)}`);
        exitCode = 1;
      }
      await sleep(500);
    }
  }
} catch (err) {
  console.error(`\nFAIL: ${String(err?.message || err).slice(0, 200)}`);
  exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}
process.exit(exitCode);
