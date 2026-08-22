// Headed Chromium, iPhone-sized, PERSISTENT profile.
// You sign in by hand once; the profile keeps the session so the automated
// lane matrix can reuse it instead of re-authenticating every run.
import { chromium, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

const URL = process.env.MOBILE_WEB_URL || 'http://localhost:8081';
const PROFILE = process.env.E2E_PROFILE || `${process.env.HOME}/.yaver-e2e-profile`;
const iphone = devices['iPhone 13'];
const executablePath = [
  process.env.YAVER_CHROMIUM_PATH,
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((candidate) => candidate && existsSync(candidate));

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

console.log(`profile: ${PROFILE}`);
console.log(`opening: ${URL}  (iPhone 13 viewport, touch enabled)`);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 180000 });
console.log('\nWindow is open. Sign in by hand — the session persists in the profile above.');
console.log('Leave it open; press Ctrl-C here when done.\n');
await new Promise(() => {});   // hold the browser open
