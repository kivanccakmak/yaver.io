import { chromium } from '@playwright/test';
const AGENT = 'http://127.0.0.1:18099';
const TOKEN = process.env.YAVER_AGENT_TOKEN;
const b = await chromium.launch();
const ctx = await b.newContext();
const page = await ctx.newPage();
// Serve from the RN-web origin so the ORIGIN header matches what the app sends.
await page.goto('http://localhost:8081/', { waitUntil: 'domcontentloaded', timeout: 90000 });
const out = await page.evaluate(async ({ agent, token }) => {
  const r = {};
  try {
    const res = await fetch(`${agent}/info`, { headers: { Authorization: `Bearer ${token}` } });
    r.status = res.status;
    const j = await res.json().catch(() => ({}));
    r.hostname = j.hostname; r.version = j.version;
  } catch (e) { r.error = String(e).slice(0, 160); }
  try {
    const res2 = await fetch(`${agent}/projects`, { headers: { Authorization: `Bearer ${token}` } });
    r.projectsStatus = res2.status;
    const j2 = await res2.json().catch(() => null);
    r.projectCount = Array.isArray(j2) ? j2.length : (j2?.projects?.length ?? 'n/a');
  } catch (e) { r.projectsError = String(e).slice(0, 120); }
  return r;
}, { agent: AGENT, token: TOKEN });
console.log('  from a BROWSER page at localhost:8081, calling the agent directly:');
console.log('   ', JSON.stringify(out));
await b.close();
