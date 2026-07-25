import { chromium } from '@playwright/test';
const PROFILE = `${process.env.HOME}/.yaver-webui-profile`;
const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('https://yaver.io/dashboard', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(12000);
const info = await page.evaluate(() => ({
  signedIn: !/Continue with (Apple|Google|GitHub)/i.test(document.body.innerText),
  text: document.body.innerText.replace(/\n+/g, ' | ').slice(0, 400),
}));
console.log(`  signed in: ${info.signedIn}`);
console.log(`  page: ${info.text.slice(0, 320)}`);
await page.screenshot({ path: '/tmp/webui-session.png', fullPage: false });
await ctx.close();
