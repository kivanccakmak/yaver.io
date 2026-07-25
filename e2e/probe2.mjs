import { chromium, devices } from '@playwright/test';
const AGENT = 'http://127.0.0.1:18099';
const auth = { Authorization: `Bearer ${process.env.YAVER_AGENT_TOKEN}` };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'], extraHTTPHeaders: auth });
await ctx.route('**/dev-web/', async (route) => {
  const res = await route.fetch();
  let html = await res.text();
  if (!/<base /i.test(html)) html = html.replace(/<head([^>]*)>/i, '<head$1><base href="/dev-web/">');
  await route.fulfill({ status: res.status(), body: html, headers: { ...res.headers(), 'content-type': 'text/html' } });
});
await ctx.addInitScript(() => {
  try {
    if (location.pathname.startsWith('/dev-web')) {
      const rest = location.pathname.slice('/dev-web'.length) || '/';
      history.replaceState(null, '', rest + location.search + location.hash);
    }
  } catch {}
});
const page = await ctx.newPage();
await page.goto(`${AGENT}/dev-web/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
let snap = { kids: 0, text: '', path: '' };
const dl = Date.now() + 75000;
while (Date.now() < dl) {
  const s = await page.evaluate(() => ({
    kids: (document.getElementById('root') || document.body)?.children.length ?? 0,
    text: (document.body?.innerText || '').trim().slice(0, 200), path: location.pathname,
  })).catch(() => null);
  if (s) { snap = s; if (s.kids > 0 && s.text.length > 0) break; }
  await sleep(3000);
}
console.log(`  base+rewrite: pathname=${snap.path} kids=${snap.kids}`);
console.log(`  text: ${JSON.stringify(snap.text.slice(0,150))}`);
await page.screenshot({ path: '/tmp/baseurl-fixed.png' });
await browser.close();
