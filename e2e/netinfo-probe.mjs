import { chromium } from '@playwright/test';
const b = await chromium.launch();
const page = await (await b.newContext()).newPage();
await page.goto('http://localhost:8081/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(8000);
const out = await page.evaluate(async () => {
  // What the connect path keys its whole strategy on.
  const r = { onLine: navigator.onLine, conn: null };
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (c) r.conn = { type: c.type, effectiveType: c.effectiveType };
  return r;
});
console.log('  browser network signals:', JSON.stringify(out));
await b.close();
