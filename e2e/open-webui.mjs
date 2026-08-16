// Headed Chromium on the WEB DASHBOARD, persistent profile so the login sticks.
import { chromium } from '@playwright/test';
const URL = process.env.WEBUI_URL || 'https://yaver.io/dashboard';
const PROFILE = process.env.E2E_PROFILE || `${process.env.HOME}/.yaver-webui-profile`;
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: ['--window-size=1300,950'],
});
const page = ctx.pages()[0] || (await ctx.newPage());
page.on('pageerror', (e) => console.log('  [pageerror]', String(e.message).slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 160)); });
console.log(`profile: ${PROFILE}\nopening: ${URL}`);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
console.log('\nWindow open. Sign in by hand — the profile keeps the session.\n');
await new Promise(() => {});
