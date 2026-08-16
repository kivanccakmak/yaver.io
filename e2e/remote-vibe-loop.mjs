/**
 * remote-vibe-loop.mjs — closed-loop RUNNER/RENDER-SPLIT vibing test.
 *
 * The loop the product sells, exercised across real machines over the relay:
 *
 *   Chromium (this PC)
 *     → render box serves the todo RN app in the browser lane (/dev-web/)
 *     → read the painted background colour
 *     → dispatch a coding task to the AI-RUNNER box ("change the background
 *       colour to <hex>") and wait for the runner to finish
 *     → watch the SAME preview until the pixel actually changes
 *     → restore the repo afterwards (deterministic git checkout via /exec)
 *
 * Verdicts follow the house scheme: PIXELS (colour changed on screen) /
 * NAMED (refused with a reason) / SILENT is the only failure.
 *
 *   RUNNER_DEVICE / RENDER_DEVICE  full device UUIDs (may be the same box)
 *   PROJECT_DIR                    project path ON THE REMOTE BOX(ES)
 *   NEW_COLOR                      target hex (default #4B0082 indigo)
 *   TASK_RUNNER                    runner id on the AI box (default codex)
 *
 * Auth: bearer token + per-user relay password from ~/.yaver/config.json —
 * never printed, never written anywhere else.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.yaver', 'config.json'), 'utf8'));
const TOKEN = (cfg.auth_token || '').trim();
const RELAY_PW = (cfg.cached_relay_password || cfg.relay_password || '').trim();
if (!TOKEN || !RELAY_PW) { console.error('NAMED  no auth_token / relay password in ~/.yaver/config.json'); process.exit(2); }

const RELAY = process.env.RELAY_URL || 'https://public.yaver.io';
const RUNNER_DEVICE = process.env.RUNNER_DEVICE || '5e79cf10-90e8-4a4f-bf07-041061dca210'; // ubuntu-4gb-hel1-1
const RENDER_DEVICE = process.env.RENDER_DEVICE || RUNNER_DEVICE;
const PROJECT_DIR = process.env.PROJECT_DIR || '/root/Workspace/yaver-todo-rn';
const PROJECT_NAME = path.basename(PROJECT_DIR);
const NEW_COLOR = process.env.NEW_COLOR || '#4B0082';
const TASK_RUNNER = process.env.TASK_RUNNER || 'codex';
const BOOT_MS = Number(process.env.BOOT_BUDGET_MS || 300_000);
const TASK_MS = Number(process.env.TASK_BUDGET_MS || 600_000);
const REPAINT_MS = Number(process.env.REPAINT_BUDGET_MS || 240_000);
const ARTIFACTS = process.env.ARTIFACT_DIR || path.join(process.cwd(), 'test-results', 'remote-vibe');

const H = { Authorization: `Bearer ${TOKEN}`, 'X-Relay-Password': RELAY_PW, 'Content-Type': 'application/json' };
const base = (dev) => `${RELAY}/d/${dev}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${now()}]`, ...a);

async function call(dev, p, init = {}) {
  const res = await fetch(`${base(dev)}${p}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
}

async function readBackground(page) {
  // RN-web paints backgrounds on nested full-bleed divs; walk down from #root
  // until a non-transparent computed colour appears, else fall back to body.
  return page.evaluate(() => {
    const opaque = (c) => c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent';
    let el = document.getElementById('root') || document.body;
    let found = '';
    const stack = [el];
    let depth = 0;
    while (stack.length && depth < 400) {
      depth += 1;
      const n = stack.shift();
      if (!(n instanceof HTMLElement)) continue;
      const r = n.getBoundingClientRect();
      if (r.width >= innerWidth * 0.8 && r.height >= innerHeight * 0.8) {
        const c = getComputedStyle(n).backgroundColor;
        if (opaque(c)) found = c; // deepest full-bleed opaque wins
        stack.push(...n.children);
      }
    }
    return found || getComputedStyle(document.body).backgroundColor;
  });
}

async function bringUpPreview() {
  log(`render box ${RENDER_DEVICE.slice(0, 8)} — starting expo web lane for ${PROJECT_DIR}`);
  await call(RENDER_DEVICE, '/dev/stop', { method: 'POST', body: '{}' }).catch(() => {});
  await sleep(2000);
  const start = await call(RENDER_DEVICE, '/dev/start', {
    method: 'POST',
    body: JSON.stringify({ framework: 'expo', workDir: PROJECT_DIR, platform: 'web', caller: 'web-ui' }),
  });
  if (start.status >= 400) throw new Error(`NAMED dev/start refused (HTTP ${start.status}): ${(start.json?.error || start.text).slice(0, 180)}`);
  const deadline = Date.now() + BOOT_MS;
  let last = '';
  while (Date.now() < deadline) {
    const st = (await call(RENDER_DEVICE, '/dev/status')).json || {};
    if (st.error) last = String(st.error);
    const previewPath = (typeof st.bundleUrl === 'string' && st.bundleUrl) || (st.webPort > 0 ? '/dev-web/' : '');
    if (previewPath) {
      const probe = await fetch(`${base(RENDER_DEVICE)}${previewPath}`, { headers: H });
      if (probe.status === 200) return previewPath;
      last = `preview ${previewPath} HTTP ${probe.status}`;
      if (probe.status >= 400 && probe.status < 500) throw new Error(`NAMED ${last}`);
    }
    await sleep(5000);
  }
  throw new Error(`NAMED no preview within ${BOOT_MS / 1000}s — last: ${last || 'no status'}`);
}

async function dispatchColorTask() {
  const prompt =
    `In the repo at ${PROJECT_DIR} change the app's main screen background colour to EXACTLY ${NEW_COLOR}. ` +
    `It is an Expo/React Native todo app; find where the screen/container background is defined ` +
    `(theme file or StyleSheet backgroundColor) and set it to ${NEW_COLOR}. ` +
    `Do NOT commit, do NOT push, do NOT run the dev server (it is already running); just edit the file(s).`;
  const res = await call(RUNNER_DEVICE, '/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: `e2e: set ${PROJECT_NAME} background to ${NEW_COLOR}`,
      description: prompt,
      runner: TASK_RUNNER,
      projectName: PROJECT_NAME,
      workDir: PROJECT_DIR,
    }),
  });
  const taskId = res.json?.taskId || res.json?.id || res.json?.task?.id;
  if (res.status >= 400 || !taskId) throw new Error(`NAMED task dispatch failed (HTTP ${res.status}): ${(res.json?.error || res.text).slice(0, 180)}`);
  log(`task ${taskId} dispatched to ${TASK_RUNNER} on ${RUNNER_DEVICE.slice(0, 8)}`);
  return taskId;
}

async function waitTask(taskId) {
  const deadline = Date.now() + TASK_MS;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const t = (await call(RUNNER_DEVICE, `/tasks/${taskId}`)).json || {};
    const s = t.status || t.task?.status || '';
    if (s && s !== lastStatus) { lastStatus = s; log(`task status: ${s}`); }
    if (['completed', 'review', 'failed', 'cancelled'].includes(s)) return s;
    await sleep(5000);
  }
  return `timeout after ${TASK_MS / 1000}s (last: ${lastStatus || 'unknown'})`;
}

async function restoreRepo() {
  // Deterministic cleanup — a coding-agent revert would be the expensive
  // answer to the cheapest question. Restore on BOTH boxes when split.
  const boxes = [...new Set([RUNNER_DEVICE, RENDER_DEVICE])];
  for (const dev of boxes) {
    // /exec is ASYNC ({execId}); poll the result — a fire-and-forget restore
    // that silently failed would leave the repo dirty and poison the next run.
    const res = await call(dev, '/exec', {
      method: 'POST',
      body: JSON.stringify({ command: `git -C ${PROJECT_DIR} checkout -- . && git -C ${PROJECT_DIR} status --porcelain | wc -l`, timeoutSec: 60 }),
    });
    const execId = res.json?.execId;
    let verdict = `HTTP ${res.status}`;
    if (execId) {
      for (let i = 0; i < 15; i++) {
        await sleep(2000);
        const st = (await call(dev, `/exec/${execId}`)).json?.exec || {};
        if (st.status === 'completed' || st.status === 'failed') {
          verdict = `exit ${st.exitCode}, dirty-files ${String(st.stdout || '').trim() || '?'}`;
          break;
        }
      }
    }
    log(`restore on ${dev.slice(0, 8)}: ${verdict}`);
  }
}

(async () => {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const split = RUNNER_DEVICE !== RENDER_DEVICE;
  log(`closed loop — runner=${RUNNER_DEVICE.slice(0, 8)} render=${RENDER_DEVICE.slice(0, 8)} ${split ? '(SPLIT)' : '(single box)'} target=${NEW_COLOR}`);

  const previewPath = await bringUpPreview();
  const url = new URL(`${base(RENDER_DEVICE)}${previewPath}`);
  url.searchParams.set('token', TOKEN);
  // Relay-side auth: __rp authorizes the FIRST browser request; the relay
  // then mints a scoped webview cookie that carries the page's asset loads
  // (relay/server.go handleProxy — header → __rp → cookie ladder).
  url.searchParams.set('__rp', RELAY_PW);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let verdict = 'SILENT';
  try {
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 120_000 });
    // Give the bundle time to mount real content.
    await page.waitForFunction(() => (document.getElementById("root")?.children.length || 0) > 0, null, { timeout: 180_000 });
    await sleep(4000);
    const before = await readBackground(page);
    await page.screenshot({ path: path.join(ARTIFACTS, 'before.png') });
    log(`BEFORE background: ${before}`);
    const expected = hexToRgb(NEW_COLOR);
    if (before === expected) throw new Error(`NAMED background is already ${expected} — pick a different NEW_COLOR`);

    const taskId = await dispatchColorTask();
    const terminal = await waitTask(taskId);
    if (!['completed', 'review'].includes(terminal)) throw new Error(`NAMED task ended ${terminal}`);
    if (terminal === 'review') {
      // Tasks run in an isolated runner clone; "review" holds the patch until
      // approval, when the clone LANDS atomically on the project tree (the
      // approve step a phone user performs). Without this the served tree
      // never changes and the loop reads SILENT — proven by a direct disk
      // edit repainting while the reviewed task's diff did not.
      const ok = await call(RUNNER_DEVICE, `/tasks/${taskId}/complete`, { method: 'POST' });
      log(`approved task ${taskId} (complete → HTTP ${ok.status})`);
    }
    // The expo web preview is a STATIC EXPORT served by the agent ("Web UI
    // bundle ready: N files") — file edits do NOT repaint by themselves.
    // The product refreshes once at task-terminal via /dev/reload; do the
    // same, then re-fetch the page until the new export paints.
    // mode:"full" is REQUIRED here: fast mode only rebuilds the static web
    // export when git HEAD moved, and a reviewed task's edit is uncommitted —
    // devserver_http.go handleDevServerReload (triggerWebBundleRebuildAsync
    // is gated on reloadMode == "full").
    const rel = await call(RENDER_DEVICE, '/dev/reload', { method: 'POST', body: JSON.stringify({ mode: 'full' }) });
    log(`task terminal — /dev/reload → HTTP ${rel.status}; watching for repaint`);

    // Metro serves the fresh bundle immediately (verified by direct fetch),
    // but Chromium's HTTP cache re-serves the OLD bundle to page.reload() —
    // the bundle URL never changes. Sample from a FRESH context (own cache)
    // each cycle, exactly like a user opening a new tab.
    const deadline = Date.now() + REPAINT_MS;
    let after = before;
    while (Date.now() < deadline) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      try {
        const p2 = await ctx.newPage();
        await p2.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 120_000 });
        await p2.waitForFunction(() => (document.getElementById("root")?.children.length || 0) > 0, null, { timeout: 120_000 });
        await sleep(3000);
        const sample = await readBackground(p2).catch(() => '');
        if (sample && sample !== 'rgba(0, 0, 0, 0)' && sample !== 'transparent') after = sample;
        if (after === expected) { await p2.screenshot({ path: path.join(ARTIFACTS, 'after.png') }); }
      } catch { /* box busy compiling — try again */ } finally {
        await ctx.close().catch(() => {});
      }
      if (after === expected) break;
      await sleep(10_000);
    }
    if (after !== expected) await page.screenshot({ path: path.join(ARTIFACTS, 'after.png') });
    log(`AFTER background: ${after} (expected ${expected})`);
    if (after === expected) {
      verdict = 'PIXELS';
    } else if (after !== before) {
      verdict = `PIXELS-PARTIAL background changed (${before} → ${after}) but not to ${expected}`;
    } else {
      verdict = 'SILENT background never changed';
    }
  } finally {
    await browser.close().catch(() => {});
    await restoreRepo().catch((e) => log(`restore failed: ${e.message}`));
    await call(RENDER_DEVICE, '/dev/stop', { method: 'POST', body: '{}' }).catch(() => {});
  }
  log(`VERDICT: ${verdict}`);
  process.exit(verdict.startsWith('PIXELS') ? 0 : 1);
})().catch(async (e) => {
  console.error(`[${now()}]`, e.message || e);
  await restoreRepo().catch(() => {});
  process.exit(e.message?.startsWith('NAMED') ? 1 : 2);
});
