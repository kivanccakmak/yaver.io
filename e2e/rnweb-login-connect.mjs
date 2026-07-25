import { chromium, devices } from '@playwright/test';
import { readFileSync } from 'fs';
const env = Object.fromEntries(readFileSync('/Users/kivanccakmak/Workspace/yaver.io/.env.test','utf8')
  .split('\n').filter(l=>l.includes('=')).map(l=>[l.slice(0,l.indexOf('=')).trim(), l.slice(l.indexOf('=')+1).trim()]));
const PROFILE = `${process.env.HOME}/.yaver-rnweb-profile`;
const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, ...devices['iPhone 13'] });
const page = ctx.pages()[0] || (await ctx.newPage());
const errs = [];
page.on('pageerror', e => errs.push(String(e.message).slice(0,120)));
await page.goto('http://localhost:8081/', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForTimeout(15000);

const body = () => page.evaluate(() => (document.body?.innerText||'').replace(/\n+/g,' | ').slice(0,300)).catch(()=> '');
let txt = await body();
if (/Continue with Email/i.test(txt)) {
  console.log('  logging in as', env.YAVER_TEST_EMAIL);
  await page.getByText(/Continue with Email/i).first().click();
  await page.waitForTimeout(3000);
  await page.getByPlaceholder(/email/i).first().fill(env.YAVER_TEST_EMAIL);
  await page.getByPlaceholder(/password/i).first().fill(env.YAVER_TEST_PASSWORD);
  await page.getByText(/^Sign In$/i).first().click();
  for (let i=0;i<12;i++){ await page.waitForTimeout(5000); txt = await body(); if(!/Continue with Email/i.test(txt)) break; }
}
console.log('  after login:', txt.slice(0,200));
// Now watch the connection state the app reports.
for (let i=0;i<14;i++){
  await page.waitForTimeout(6000);
  const t = await body();
  if (/Connected|Transport pending|Reconnecting|Pick a machine|Disconnected/i.test(t)) { console.log('  connection:', t.slice(0,220)); break; }
  if (i===13) console.log('  connection: (no state text) ', t.slice(0,200));
}
if (errs.length) console.log('  page errors:', errs.slice(0,2).join(' || '));
await page.screenshot({ path: '/tmp/rnweb-connect.png' });
await ctx.close();
