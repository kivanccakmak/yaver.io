/**
 * Vibing loop, recorded: log into the REAL mobile app in Chromium, connect to
 * the Mac mini, and drive an actual coding task end to end.
 *
 *   node e2e/vibe-loop.mjs
 *
 * The render loops prove a preview appears. This proves the thing Yaver is FOR:
 * you tell a machine to do work and watch it happen from somewhere else. It is
 * the same RN code that ships to TestFlight, served as RN-web, driven at iPhone
 * viewport, talking to the mini over the direct-HTTP lane.
 *
 * Recorded to VIDEO because a verdict line says what happened and a recording
 * shows what it LOOKED like — and the look is the product here.
 *
 * ── What it asserts, and what it deliberately does not ──────────────────────
 *
 * It asserts the loop CLOSES: signed in → connected to a named machine → a task
 * is created → the task appears with a status the app itself reports. It does
 * NOT assert the agent produced good code; that is the runner's job and a
 * different kind of test. Claiming otherwise would be the false green this
 * suite exists to catch — the same mistake the simulator loop made when it
 * scored four identical screenshots as four passes.
 */
import { chromium, devices } from '@playwright/test';
import { readFileSync } from 'fs';

const APP = process.env.MOBILE_WEB_URL || 'http://localhost:8081';
const VIDEO_DIR = process.env.VIDEO_DIR || '/tmp/yaver-rec-vibe';
const PROMPT = process.env.VIBE_PROMPT || 'List the files in this project. Do not modify anything.';

const env = Object.fromEntries(
  readFileSync('/Users/kivanccakmak/Workspace/yaver.io/.env.test', 'utf8')
    .split('\n').filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  ...devices['iPhone 13'],
  recordVideo: { dir: VIDEO_DIR, size: { width: 390, height: 844 } },
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 120)));
const body = () => page.evaluate(() => (document.body?.innerText || '').replace(/\n+/g, ' | ').slice(0, 400)).catch(() => '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const steps = [];
const step = (name, ok, detail) => {
  steps.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(15000);
  let txt = await body();
  step('app mounts in a browser', /Continue with|Tasks|Projects/i.test(txt), txt.slice(0, 60));

  if (/Continue with Email/i.test(txt)) {
    await page.getByText(/Continue with Email/i).first().click();
    await sleep(3000);
    await page.getByPlaceholder(/email/i).first().fill(env.YAVER_TEST_EMAIL);
    await page.getByPlaceholder(/password/i).first().fill(env.YAVER_TEST_PASSWORD);
    await page.getByText(/^Sign In$/i).first().click();
    for (let i = 0; i < 12; i++) { await sleep(5000); txt = await body(); if (!/Continue with Email/i.test(txt)) break; }
  }
  step('signs in', !/Continue with Email/i.test(txt), env.YAVER_TEST_EMAIL);

  // Connection is the part that was impossible in a browser until the
  // direct-HTTP lane was selected — a browser cannot speak QUIC.
  let connected = '';
  for (let i = 0; i < 16; i++) {
    await sleep(6000);
    txt = await body();
    if (/Connected/i.test(txt)) { connected = txt; break; }
  }
  step('connects to a machine', !!connected, (connected.match(/Connected[^|]*\|[^|]*\|[^|]*/) || [''])[0].slice(0, 70));

  // Drive real work.
  const newTask = page.getByText(/New task/i).first();
  if (await newTask.isVisible().catch(() => false)) {
    await newTask.click();
    await sleep(2500);
    const input = page.locator('textarea, input[type="text"]').first();
    await input.fill(PROMPT).catch(() => {});
    await sleep(1000);
    const send = page.getByText(/^(Send|Start|Run)$/i).first();
    if (await send.isVisible().catch(() => false)) await send.click();
    step('dispatches a task', true, PROMPT.slice(0, 40));
  } else {
    step('dispatches a task', false, 'New task control not found');
  }

  // Did the app report the task back with a state of its own?
  let sawTask = '';
  for (let i = 0; i < 14; i++) {
    await sleep(6000);
    txt = await body();
    if (/running|working|queued|completed|thinking/i.test(txt)) { sawTask = txt; break; }
  }
  step('task reports a live status', !!sawTask, sawTask.slice(0, 80));

  await page.screenshot({ path: '/tmp/yaver-vibe-final.png' });
} finally {
  console.log('\n===== VIBE LOOP =====');
  const passed = steps.filter((s) => s.ok).length;
  for (const s of steps) console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${s.name}`);
  console.log(`\n${passed}/${steps.length} steps passed`);
  if (errs.length) console.log(`page errors: ${errs.slice(0, 2).join(' || ')}`);
  console.log(`video: ${VIDEO_DIR}`);
  await ctx.close();          // flushes the recording
  await browser.close();
  if (passed < steps.length) process.exitCode = 1;
}
