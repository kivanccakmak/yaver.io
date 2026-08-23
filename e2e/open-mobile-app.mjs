// Headed Chromium, iPhone-sized, PERSISTENT profile.
// You sign in by hand once; the profile keeps the session so the automated
// lane matrix can reuse it instead of re-authenticating every run.
import { chromium, devices } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_APP_PORT = 8081;
const MOBILE_SHELL_MARKER = '/yaver-mobile-shell.json';
let APP_URL = process.env.MOBILE_WEB_URL || `http://127.0.0.1:${DEFAULT_APP_PORT}`;
const PROFILE = process.env.E2E_PROFILE || `${process.env.HOME}/.yaver-e2e-profile`;
const iphone = devices['iPhone 13'];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mobileDir = resolve(repoRoot, 'mobile');
const expoBin = resolve(mobileDir, 'node_modules', '.bin', 'expo');
const executablePath = [
  process.env.YAVER_CHROMIUM_PATH,
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((candidate) => candidate && existsSync(candidate));

async function appResponds() {
  try {
    const response = await fetch(APP_URL, { signal: AbortSignal.timeout(5000) });
    const body = await response.text();
    if (!response.ok || !/text\/html/i.test(response.headers.get('content-type') || '') || body.length === 0) {
      return false;
    }
    // An explicit URL is user-owned. For the automatic localhost lane, prove
    // the listener is Yaver's mobile shell rather than accepting any HTML app
    // that happened to claim Metro's conventional :8081 (sfmg did exactly
    // that, and the launcher opened the wrong product without complaint).
    if (process.env.MOBILE_WEB_URL) return true;
    const marker = await fetch(new URL(MOBILE_SHELL_MARKER, APP_URL), {
      signal: AbortSignal.timeout(1500),
      cache: 'no-store',
    });
    const identity = await marker.json().catch(() => null);
    return marker.ok && identity?.product === 'yaver-mobile';
  } catch {
    return false;
  }
}

async function portIsFree(port) {
  return await new Promise((resolveFree) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', () => resolveFree(false));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      probe.close(() => resolveFree(true));
    });
  });
}

async function selectLocalAppURL() {
  if (process.env.MOBILE_WEB_URL || await appResponds()) return;
  for (let port = DEFAULT_APP_PORT; port <= DEFAULT_APP_PORT + 40; port += 1) {
    if (await portIsFree(port)) {
      if (port !== DEFAULT_APP_PORT) {
        console.log(`port ${DEFAULT_APP_PORT} belongs to another app; Yaver RN-web will use ${port}`);
      }
      APP_URL = `http://127.0.0.1:${port}`;
      return;
    }
  }
  throw new Error(`No free local port in ${DEFAULT_APP_PORT}..${DEFAULT_APP_PORT + 40} for Yaver RN-web.`);
}

async function ensureMobileWebApp() {
  await selectLocalAppURL();
  if (await appResponds()) return null;

  if (process.env.MOBILE_WEB_URL) {
    throw new Error(
      `MOBILE_WEB_URL is not responding (${new URL(APP_URL).origin}). Start that RN-web server and retry.`,
    );
  }
  if (!existsSync(expoBin)) {
    throw new Error('Expo is not installed for mobile/. Run `cd mobile && npm install`, then retry this command.');
  }

  console.log(`RN-web is not serving on ${APP_URL}; starting Expo from ${mobileDir}`);
  const startedAt = Date.now();
  const selectedPort = new URL(APP_URL).port || String(DEFAULT_APP_PORT);
  const child = spawn(expoBin, ['start', '--web', '--port', selectedPort, '--host', 'localhost'], {
    cwd: mobileDir,
    // `expo start --web` otherwise opens a second, ordinary desktop browser.
    // This launcher owns the one full mobile-device context used for the test.
    env: { ...process.env, BROWSER: 'none', EXPO_NO_TELEMETRY: '1' },
    stdio: 'inherit',
  });

  const deadline = startedAt + 180_000;
  let lastProgressSecond = -1;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Expo exited with code ${child.exitCode} before RN-web answered on ${APP_URL}.`);
    }
    if (await appResponds()) {
      console.log(`RN-web ready after ${Math.ceil((Date.now() - startedAt) / 1000)}s`);
      return child;
    }
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    if (elapsedSeconds >= 5 && elapsedSeconds % 10 === 0 && elapsedSeconds !== lastProgressSecond) {
      lastProgressSecond = elapsedSeconds;
      console.log(`waiting for RN-web · ${elapsedSeconds}s elapsed`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }

  child.kill('SIGTERM');
  throw new Error(`Expo did not answer on ${APP_URL} within 180s. Review the streamed Expo output above.`);
}

const startedDevServer = await ensureMobileWebApp();

async function openWhenMounted(page) {
  const startedAt = Date.now();
  const deadline = startedAt + 180_000;
  let attempt = 0;
  let lastError;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForFunction(
        () => document.getElementById('root')?.children.length > 0,
        { timeout: 30_000 },
      );
      console.log(`mobile app mounted after ${Math.ceil((Date.now() - startedAt) / 1000)}s`);
      return;
    } catch (error) {
      lastError = error;
      if (page.isClosed()) throw error;
      const cause = String(error?.message || error).split('\n')[0];
      console.log(`mobile app not mounted yet · attempt ${attempt} · ${cause}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
    }
  }
  throw new Error(`RN-web answered but the mobile app did not mount within 180s: ${lastError?.message || 'unknown error'}`);
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  ...(executablePath ? { executablePath } : {}),
  headless: false,
  viewport: iphone.viewport,
  userAgent: iphone.userAgent,
  deviceScaleFactor: iphone.deviceScaleFactor,
  isMobile: iphone.isMobile,
  hasTouch: true,
  // Manual verification should stay cheap: one mobile surface does not need
  // Chrome's default renderer pool, sync, extensions, or background apps.
  args: [
    '--window-size=430,932',
    '--renderer-process-limit=2',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
  ],
});

const existingPages = ctx.pages();
const page = existingPages[0] || (await ctx.newPage());
// A persistent profile can restore old tabs. They are test-profile tabs, not
// the user's regular browser, and keeping them silently multiplies RAM.
await Promise.all(existingPages.slice(1).map((extra) => extra.close()));
page.on('console', (m) => { if (m.type() === 'error') console.log('  [app error]', m.text().slice(0, 160)); });
page.on('pageerror', (e) => console.log('  [pageerror]', String(e.message).slice(0, 200)));
// Browser console messages such as "Failed to load resource: 502" omit the
// endpoint, which turned the 2026-08-23 remote-runner failure into a wall of
// identical, unactionable lines. Name the failing path without printing the
// host (device addresses are private) or query string (tokens never belong in
// URLs, but the harness should not amplify a regression if one appears).
const failedResponseCounts = new Map();
page.on('response', (response) => {
  if (response.status() < 400) return;
  const url = new URL(response.url());
  const key = `${response.status()} ${url.pathname}`;
  const count = (failedResponseCounts.get(key) || 0) + 1;
  failedResponseCounts.set(key, count);
  if (count <= 3) console.log(`  [http ${response.status()}] ${url.pathname}${count > 1 ? ` (x${count})` : ''}`);
});
page.on('requestfailed', (request) => {
  const url = new URL(request.url());
  console.log(`  [request failed] ${url.pathname} · ${request.failure()?.errorText || 'unknown error'}`);
});

console.log(`profile: ${PROFILE}`);
console.log(`opening: ${APP_URL}  (iPhone 13 viewport, touch enabled)`);
await openWhenMounted(page);
console.log('\nWindow is open. Sign in by hand — the session persists in the profile above.');
console.log(`Leave it open; press Ctrl-C here when done.${startedDevServer ? ' The Expo server will stop with this terminal.' : ''}\n`);
await new Promise(() => {});   // hold the browser open
