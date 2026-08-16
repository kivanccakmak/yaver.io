/**
 * feedback-browser-lane-loop.mjs — closed loop for the BROWSER-lane feedback
 * icon (docs/audits/feedback-sdk-lanes-audit-2026-07-28.md).
 *
 * Proves, in a REAL Chromium (the browser lane's actual engine), that the
 * lane-aware yaver-feedback-web SDK, when Yaver stamps window.__yaverLane =
 * "browser", self-hosts a DRAGGABLE DOM floating icon that opens the overlay —
 * the occlusion-proof affordance that replaces the dead iOS shake path.
 *
 *   node e2e/feedback-browser-lane-loop.mjs
 *
 * Serves the SDK's built dist over http (ESM needs an origin), loads a page
 * that stamps the lane like the WebView does, calls init(), and asserts:
 *   1. #yaver-feedback-btn mounts (position:fixed, z-index 99999),
 *   2. a >5px drag MOVES it (and persists), a <5px tap does NOT,
 *   3. a tap opens the DOM overlay.
 * Verdict: PIXELS (all three) / NAMED (a checked failure) / SILENT (crash).
 */
import { chromium } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../sdk/feedback/web/dist');
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.map': 'application/json', '.html': 'text/html' };
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

if (!fs.existsSync(path.join(DIST, 'index.js'))) {
  console.error('NAMED  sdk/feedback/web/dist missing — run `npm run build` in sdk/feedback/web first');
  process.exit(1);
}

// Minimal static server for the dist + a test page that mimics the WebView:
// stamp the lane BEFORE loading the SDK, then init() with a bogus agentUrl so
// discovery is skipped (we test the DOM affordance, not the agent round-trip).
const PAGE = `<!doctype html><html><head><meta charset=utf8></head><body>
<div id="root"><h1>guest app</h1></div>
<script>window.__yaverLane = 'browser';</script>
<script type="module">
  import { YaverFeedback } from '/index.js';
  window.__ready = YaverFeedback.init({ agentUrl: 'http://127.0.0.1:65535', enabled: true, trigger: 'none' })
    .then(() => { window.__lane = YaverFeedback.lane; return true; })
    .catch((e) => { window.__initErr = String(e); return true; });
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); return;
  }
  // tsc emits extensionless relative imports (`./YaverFeedback`); a real
  // bundler (metro/webpack) resolves them, so mimic that: append .js when the
  // requested path has no extension and no exact file.
  let rel = req.url.split('?')[0];
  let f = path.join(DIST, rel);
  if (!fs.existsSync(f) && !path.extname(f) && fs.existsSync(f + '.js')) f += '.js';
  if (!f.startsWith(DIST) || !fs.existsSync(f)) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

const verdicts = [];
const check = (name, ok, detail) => { verdicts.push({ name, ok, detail }); log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };

await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(base, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForFunction(() => window.__ready !== undefined, { timeout: 15000 }).catch(() => {});
  await page.waitForSelector('#yaver-feedback-btn', { timeout: 10000 }).catch(() => {});

  const mounted = await page.evaluate(() => {
    const b = document.getElementById('yaver-feedback-btn');
    if (!b) return null;
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    return { pos: cs.position, z: cs.zIndex, x: r.left, y: r.top, text: b.textContent };
  });
  check('lane resolved to browser', (await page.evaluate(() => window.__lane)) === 'browser');
  check('icon mounted (fixed, z-index 99999, "Y")',
    !!mounted && mounted.pos === 'fixed' && mounted.z === '99999' && mounted.text === 'Y',
    mounted ? `pos=${mounted.pos} z=${mounted.z}` : 'NOT MOUNTED');

  if (mounted) {
    // DRAG: >5px move must reposition and must NOT open the overlay.
    const bb = await page.locator('#yaver-feedback-btn').boundingBox();
    await page.mouse.move(bb.x + 22, bb.y + 22);
    await page.mouse.down();
    await page.mouse.move(bb.x - 100, bb.y - 200, { steps: 8 });
    await page.mouse.up();
    const after = await page.evaluate(() => document.getElementById('yaver-feedback-btn').getBoundingClientRect().left);
    check('drag moved the icon', Math.abs(after - mounted.x) > 20, `left ${Math.round(mounted.x)}→${Math.round(after)}`);
    check('drag did NOT open the overlay',
      !(await page.evaluate(() => !!document.querySelector('#yaver-feedback-report,[class*="yvr-fb"],[id*="feedback-report"]'))));

    // TAP: click without moving must open the overlay.
    await page.locator('#yaver-feedback-btn').click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);
    const overlayUp = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('body *'));
      return nodes.some((n) => {
        const cs = getComputedStyle(n);
        return cs.position === 'fixed' && Number(cs.zIndex) >= 99998 && n.id !== 'yaver-feedback-btn' &&
          n.getBoundingClientRect().width > 200;
      });
    });
    check('tap opened the overlay', overlayUp);
  }
} finally {
  await browser.close().catch(() => {});
  server.close();
}

const failed = verdicts.filter((v) => !v.ok);
const verdict = verdicts.length === 0 ? 'SILENT' : failed.length ? `NAMED (${failed.map((f) => f.name).join('; ')})` : 'PIXELS';
log(`VERDICT: ${verdict}`);
process.exit(verdict === 'PIXELS' ? 0 : 1);
