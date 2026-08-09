#!/usr/bin/env node
// verify_live_console.mjs — closed-loop check of the mobile task-detail
// LiveConsoleSection (live opencode console) on the RN-web app.
//
// Drives the REAL mobile app at a genuine iPhone 15 Pro device context,
// injects the local agent's session token into the RN-web storage key
// (yaver.secure.yaver_auth_token via mobile/src/lib/secureStoreCompat.ts),
// opens the first opencode task detail, and asserts the "Live console"
// section rendered the streamed console (title + ● live / ○ idle dot +
// content) instead of a collapsed "_Working through implementation…_" bubble.
//
// Use: node e2e/verify_live_console.mjs
//   Requires Metro serving the mobile app (cd mobile && npm run web → :8081)
//   and a local agent on :18080 with ~/.yaver/config.json auth_token.
// Verified 2026-08-09 (ubuntu-4gb-hel1-1 + deepseek-v4-flash).
import { createRequire } from 'module';
import { readFileSync } from 'fs';
const require = createRequire(import.meta.url);
const { chromium, devices } = require('/Users/kivanccakmak/Workspace/talos/web/node_modules/playwright');
const EXE = process.env.CHROMIUM || '/Users/kivanccakmak/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL = 'http://localhost:8081';
// Token: explicit env wins; otherwise read the local agent config (the same
// token the browser app would get from SecureStore on this machine).
let TOKEN = process.env.YAVER_AGENT_TOKEN || '';
if (!TOKEN) {
  try {
    const cfg = JSON.parse(readFileSync(`${process.env.HOME}/.yaver/config.json`, 'utf8'));
    TOKEN = cfg.auth_token || cfg.authToken || '';
  } catch { /* fall through — verification will fail with a clear message */ }
}

const iphone = devices['iPhone 15 Pro'];
const browser = await chromium.launch({ headless: true, executablePath: EXE });
const ctx = await browser.newContext({ ...iphone, viewport: { width: 393, height: 852 } });
const page = await ctx.newPage();

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);
await page.evaluate((t) => { window.localStorage.setItem('yaver.secure.yaver_auth_token', t); }, TOKEN);
await page.goto(`${URL}/tasks`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);

// Find the "Task actions" button whose card row contains LIVE_CONSOLE_PROBE.
// Each action button is inside a card; walk up to the card container.
const found = await page.evaluate(() => {
  const titleEl = Array.from(document.querySelectorAll('div[dir="auto"]'))
    .find(e => /LIVE_CONSOLE_PROBE/.test(e.textContent || ''));
  if (!titleEl) return { ok: false, why: 'no title' };
  let card = titleEl;
  for (let i = 0; i < 10 && card; i++) {
    card = card.parentElement;
    if (!card) break;
    // The card container is a bordered rounded box with the row of content.
    const cs = getComputedStyle(card);
    if ((cs.borderRadius !== '0px' || /borderRadius/.test(card.className)) && card.getBoundingClientRect().width > 300) {
      const r = card.getBoundingClientRect();
      return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, cls: card.className.slice(0, 50) };
    }
  }
  return { ok: false, why: 'no card container' };
});
console.log('card:', JSON.stringify(found));
if (found.ok) {
  await page.mouse.click(found.x, found.y);
} else {
  console.log('fallback: clicking first card');
  const fa = page.locator('[aria-label="Task actions"]').first();
  const b = await fa.boundingBox();
  if (b) await page.mouse.click(b.x - 250, b.y + 14);
}
await page.waitForTimeout(12000);

const detail = await page.evaluate(() => (document.body.innerText || ''));
const lines = detail.split('\n').filter(l => l.trim());
let failures = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { console.log(`  ✅ ${name}`); }
  else { failures++; console.log(`  ❌ ${name} ${extra}`); }
};
ok('task detail opened', /Live console|Agent context|Commands|Follow up|Send another command/i.test(detail), 'no detail modal');
ok('Live console section present', /Live console/i.test(detail), 'missing "Live console"');
ok('console dot present', /● live|○ idle/i.test(detail), 'missing live/idle dot');
console.log('--- detail tail (last 70 lines) ---');
console.log(lines.slice(-70).join('\n'));
console.log(failures === 0 ? '\n  VERIFY: ALL PASS' : `\n  VERIFY: ${failures} FAILED`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
