import { chromium, devices } from '@playwright/test';
const PROFILE = `${process.env.HOME}/.yaver-e2e-profile`;
const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, ...devices['iPhone 13'] });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('http://localhost:8081/', { waitUntil: 'domcontentloaded', timeout: 120000 });
// Give the app time to mount and run its connect path.
let best = '';
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(6000);
  const t = await page.evaluate(() => (document.body?.innerText || '').replace(/\n+/g, ' | ').slice(0, 260)).catch(() => '');
  if (t) best = t;
  if (/Connected|Transport pending|Agent status|Reconnecting|Pick a machine/i.test(t)) break;
}
console.log('  app says:', best.slice(0, 240));
await page.screenshot({ path: '/tmp/connect-probe.png' });
await ctx.close();
