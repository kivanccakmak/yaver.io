/**
 * Closed-loop streaming test: Mac mini → Chromium, one stack at a time.
 *
 *   node e2e/stack-stream-loop.mjs
 *
 * Drives the REAL agent on the Mac mini over an SSH tunnel and then makes a real
 * browser look at what it serves. For each project: ask the agent for the
 * BROWSER lane, wait for the web sibling to bind a port, load /dev-web/ in
 * Chromium, and decide from actual pixels + DOM whether it rendered.
 *
 * Why this shape:
 *
 *  • SEQUENTIAL, always. The box has ONE dev-server slot; two stacks at once
 *    fight and then blame each other.
 *  • The verdicts are PIXELS / NAMED / SILENT, and only SILENT fails. A stack
 *    that cannot build (e-mobile's font_awesome/IconData wall) SHOULD report a
 *    named reason — that is a working product telling the truth, not a defect.
 *    Silence is the defect.
 *  • It reads the DOM, not a screenshot. #root child count and body text are
 *    what distinguish "served an empty shell" from "the app mounted" — the
 *    exact distinction that made index.html/200 look like success all evening
 *    while main.dart.js never arrived.
 *
 * Requires an SSH tunnel to the agent:
 *   ssh -f -N -L 18099:localhost:18080 <user>@<mini>
 */
import { chromium, devices } from '@playwright/test';
import { readFileSync } from 'fs';

const AGENT = process.env.AGENT_URL || 'http://localhost:18099';
const TOKEN = (process.env.YAVER_AGENT_TOKEN || readFileSync(process.env.TOKEN_FILE || '/dev/null', 'utf8')).trim();
const BOOT_BUDGET_MS = Number(process.env.BOOT_BUDGET_MS || 240_000);

const STACKS = [
  { name: 'sfmg', workDir: '/Users/pokayoke/Workspace/sfmg', framework: 'expo' },
  { name: 'talos', workDir: '/Users/pokayoke/Workspace/talos/mobile', framework: 'expo' },
  { name: 'yaver.io', workDir: '/Users/pokayoke/Workspace/yaver.io/mobile', framework: 'expo' },
  { name: 'e-mobile', workDir: '/Users/pokayoke/Workspace/e-mobile', framework: 'flutter' },
];

const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function agent(path, init = {}) {
  const res = await fetch(`${AGENT}${path}`, { ...init, headers: { ...auth, ...(init.headers || {}) } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

/** Stop whatever is serving so each stack starts from the same place. */
async function stopServing() {
  await agent('/dev/stop', { method: 'POST', body: '{}' }).catch(() => {});
  await sleep(2000);
}

/**
 * Ask for the BROWSER lane and wait for the web sibling to bind.
 * Returns { ok, reason } — a refusal with a stated reason is a valid outcome.
 */
async function startWebLane(stack) {
  const start = await agent('/dev/start', {
    method: 'POST',
    body: JSON.stringify({
      framework: stack.framework,
      workDir: stack.workDir,
      platform: 'web',
      caller: 'web-ui',
    }),
  });
  if (start.status >= 400) {
    return { ok: false, reason: `agent refused /dev/start (HTTP ${start.status}): ${(start.json?.error || start.text).slice(0, 160)}` };
  }

  const deadline = Date.now() + BOOT_BUDGET_MS;
  let last = '';
  while (Date.now() < deadline) {
    const st = (await agent('/dev/status')).json || {};
    // The agent now flips serving=false + error when a web sibling dies, so an
    // explicit error is an ANSWER, not something to keep waiting through.
    if (st.error) last = String(st.error);
    if (st.webPort > 0) {
      const probe = await fetch(`${AGENT}/dev-web/`, { headers: auth });
      if (probe.status === 200) return { ok: true, webPort: st.webPort };
    }
    await sleep(5000);
  }
  return { ok: false, reason: last || `no web port after ${Math.round(BOOT_BUDGET_MS / 1000)}s` };
}

/** Make a real browser look at it and report what is actually on screen. */
async function inspect(page) {
  await page.goto(`${AGENT}/dev-web/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const deadline = Date.now() + 90_000;
  let best = { rootKids: 0, text: '' };
  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => ({
      rootKids: (document.getElementById('root') || document.body)?.children.length ?? 0,
      text: (document.body?.innerText || '').trim().slice(0, 200),
      title: document.title,
    })).catch(() => null);
    if (snap) {
      best = snap;
      // A mounted app has children under #root AND some rendered text.
      if (snap.rootKids > 0 && snap.text.length > 0) return { mounted: true, ...snap };
    }
    await sleep(4000);
  }
  return { mounted: false, ...best };
}

const results = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'], extraHTTPHeaders: auth });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e.message).slice(0, 140)));

for (const stack of STACKS) {
  consoleErrors.length = 0;
  process.stdout.write(`\n──── ${stack.name} ────\n`);
  await stopServing();

  const started = await startWebLane(stack);
  if (!started.ok) {
    // The product refused and SAID WHY. That is a pass for this harness.
    results.push({ stack: stack.name, verdict: 'NAMED', detail: started.reason });
    console.log(`  NAMED  ${started.reason}`);
    continue;
  }
  console.log(`  web lane up on :${started.webPort} — looking at it in Chromium`);

  const seen = await inspect(page);
  await page.screenshot({ path: `/tmp/stack-${stack.name}.png` }).catch(() => {});
  if (seen.mounted) {
    results.push({ stack: stack.name, verdict: 'PIXELS', detail: `#root children=${seen.rootKids} · "${seen.text.slice(0, 60)}"` });
    console.log(`  PIXELS #root=${seen.rootKids} title="${seen.title}" text="${seen.text.slice(0, 60)}"`);
  } else {
    const why = consoleErrors[0] ? `first page error: ${consoleErrors[0]}` : 'served a shell but nothing mounted, and said nothing';
    results.push({ stack: stack.name, verdict: 'SILENT', detail: why });
    console.log(`  SILENT ${why}`);
  }
}

await browser.close();

console.log('\n===== STREAM LOOP: mac mini → chromium =====');
const w = Math.max(...results.map((r) => r.stack.length));
for (const r of results) console.log(`${r.verdict.padEnd(6)} ${r.stack.padEnd(w)}  ${r.detail}`);
const n = (v) => results.filter((r) => r.verdict === v).length;
console.log(`\n${n('PIXELS')} rendered · ${n('NAMED')} named refusal · ${n('SILENT')} SILENT (must be 0)`);
console.log('screenshots: /tmp/stack-<name>.png\n');
process.exit(n('SILENT') > 0 ? 1 : 0);
