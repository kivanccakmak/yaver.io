/**
 * Is "Unmatched Route" caused by the /dev-web/ proxy prefix?
 *
 * The agent serves a guest app under /dev-web/. Assets resolve (the agent
 * rewrites <base href>), the bundle loads, the app MOUNTS — and then
 * expo-router reads window.location.pathname, sees "/dev-web/", matches no
 * route, and renders its 404. So a perfectly working dev server produces a
 * screen that says "Page could not be found."
 *
 * This decides it without touching the agent: load the same URL twice, once
 * plain and once with history.replaceState('/') applied BEFORE any app script
 * runs. If the second render differs, the prefix is the cause.
 */
import { chromium, devices } from '@playwright/test';

const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:18099';
const TOKEN = (process.env.YAVER_AGENT_TOKEN || '').trim();
const auth = { Authorization: `Bearer ${TOKEN}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function look(page, label) {
  await page.goto(`${AGENT}/dev-web/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  let snap = { kids: 0, text: '' };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => ({
      kids: (document.getElementById('root') || document.body)?.children.length ?? 0,
      text: (document.body?.innerText || '').trim().slice(0, 160),
      path: location.pathname,
    })).catch(() => null);
    if (s) {
      snap = s;
      if (s.kids > 0 && s.text.length > 0) break;
    }
    await sleep(3000);
  }
  console.log(`  ${label}: pathname=${snap.path} kids=${snap.kids}`);
  console.log(`    text: ${JSON.stringify(snap.text.slice(0, 120))}`);
  return snap;
}

const browser = await chromium.launch();

// ── Control: exactly what the harness saw ────────────────────────────────────
const plain = await browser.newContext({ ...devices['iPhone 13'], extraHTTPHeaders: auth });
const p1 = await plain.newPage();
const before = await look(p1, 'WITHOUT rewrite');
await p1.screenshot({ path: '/tmp/baseurl-before.png' });
await plain.close();

// ── Treatment: make the router believe it is at "/" ─────────────────────────
const fixed = await browser.newContext({ ...devices['iPhone 13'], extraHTTPHeaders: auth });
await fixed.addInitScript(() => {
  // Runs BEFORE any page script. Assets still resolve through <base href>,
  // which the agent already rewrites; only the ROUTE the app reads changes.
  try {
    if (location.pathname.startsWith('/dev-web')) {
      const rest = location.pathname.slice('/dev-web'.length) || '/';
      history.replaceState(null, '', rest + location.search + location.hash);
    }
  } catch { /* ignore */ }
});
const p2 = await fixed.newPage();
const after = await look(p2, 'WITH rewrite');
await p2.screenshot({ path: '/tmp/baseurl-after.png' });
await fixed.close();

await browser.close();

const changed = before.text !== after.text;
console.log(`\nVERDICT: ${changed ? 'THE PREFIX IS THE CAUSE — rewriting the path changed what rendered' : 'unchanged — the prefix is NOT the cause, look elsewhere'}`);
console.log('screenshots: /tmp/baseurl-before.png /tmp/baseurl-after.png');
