import { chromium, devices } from '@playwright/test';
import { readFileSync } from 'fs';
const env = Object.fromEntries(readFileSync('.env.test','utf8').split('\n').filter(l=>l.includes('=')).map(l=>[l.slice(0,l.indexOf('=')).trim(),l.slice(l.indexOf('=')+1).trim()]));
const b = await chromium.launch();
const ctx = await b.newContext({ ...devices['iPhone 15'] });
const p = await ctx.newPage();
p.on('console', m => { const t=m.text(); if (/auth|token|sign|error/i.test(t)) console.log('  [console]', t.slice(0,140)); });
await p.goto('http://localhost:8097', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(9000);
console.log('--- on load ---');
console.log((await p.evaluate(()=>document.body.innerText)).slice(0,200).replace(/\n+/g,' | '));
// Click Continue with Email
const emailBtn = p.getByText(/Continue with Email/i).first();
if (await emailBtn.count()) { await emailBtn.click(); await p.waitForTimeout(4000); }
console.log('--- after Continue with Email ---');
console.log((await p.evaluate(()=>document.body.innerText)).slice(0,300).replace(/\n+/g,' | '));
await p.getByPlaceholder('Email').first().fill(env.YAVER_TEST_EMAIL);
await p.getByPlaceholder('Password').first().fill(env.YAVER_TEST_PASSWORD);
await p.getByText(/^Sign In$/).first().click();
await p.waitForTimeout(15000);
console.log('--- after Sign In ---');
console.log((await p.evaluate(()=>document.body.innerText)).slice(0,300).replace(/\n+/g,' | '));
console.log('--- Projects tab ---');
const tabs = await p.locator('[role=button],button,a').filter({ hasText: /Projects/ }).count();
console.log('project-tab candidates:', tabs);
for (let i=0;i<tabs;i++){
  await p.locator('[role=button],button,a').filter({ hasText: /Projects/ }).nth(i).click().catch(()=>{});
  await p.waitForTimeout(5000);
  const t=(await p.evaluate(()=>document.body.innerText)).slice(0,200).replace(/\n+/g,' | ');
  console.log(`  [${i}] ${t}`);
  if (!/Active · |Review · /.test(t)) { console.log('  -> navigated'); break; }
}
console.log('selects:', await p.locator('select').count(), 'iframes:', await p.locator('iframe').count());
await b.close();
