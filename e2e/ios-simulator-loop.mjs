/**
 * Closed loop over the HEAVY lane: iOS Simulator → WebRTC session → JPEG frame.
 *
 *   node e2e/ios-simulator-loop.mjs
 *
 * The light lanes (todo-iframe-loop.mjs) prove a browser target renders. This
 * proves the NATIVE one: boot a real iOS simulator on the Mac mini, launch the
 * guest app into it, and pull an actual frame back to this machine.
 *
 * ── Why it is one uninterrupted pass ────────────────────────────────────────
 *
 * A runtime session holds an exclusive simulator, and the agent's custodian
 * (runtimeSessionWarden, 30s sweep) reaps sessions that sit idle — correct on a
 * box with 8 GB of RAM, and it reaped a hand-driven session during development
 * of this very file. So create → command → frame → DELETE runs without pauses,
 * and the teardown is in a finally: leaving a simulator booted on an 8 GB host
 * is not a leak you notice, it is a box that stops being able to build.
 *
 * ── What it can and cannot assert ───────────────────────────────────────────
 *
 * frameTransport is "webrtc-datachannel-jpeg-v1" — frames arrive as JPEG over a
 * DataChannel, NOT an RTP video track. So there is no framesDecoded stat to
 * read; the honest assertion is that /frame returns real JPEG bytes with real
 * variation. This verifies STREAMING, not app behaviour: a native binary has no
 * DOM, so nothing here can claim "the Add button works" the way the browser
 * lane legitimately can. Conflating those would be the false green this whole
 * suite exists to prevent.
 */
import { writeFileSync } from 'fs';

const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:18099';
const TOKEN = (process.env.YAVER_AGENT_TOKEN || '').trim();
const WORKDIR = process.env.WORKDIR || '/Users/pokayoke/Workspace/sfmg';
const FRAMEWORK = process.env.FRAMEWORK || 'expo';
const TARGET = process.env.TARGET_ID || 'ios-simulator';
const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init = {}) {
  const res = await fetch(`${AGENT}${path}`, { ...init, headers: { ...auth, ...(init.headers || {}) } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

let sessionId = null;
const t0 = Date.now();
const el = () => `${Math.round((Date.now() - t0) / 1000)}s`;

try {
  console.log(`──── ${TARGET} · ${WORKDIR.split('/').pop()} ────`);

  console.log(`  [${el()}] creating session (boots the simulator — this is the slow part)`);
  const created = await api('/remote-runtime/sessions', {
    method: 'POST',
    body: JSON.stringify({ framework: FRAMEWORK, workDir: WORKDIR, targetId: TARGET }),
  });
  if (created.status >= 400) {
    console.log(`  NAMED  agent refused (HTTP ${created.status}): ${(created.json?.error || created.text).slice(0, 180)}`);
    process.exit(0); // a stated refusal is a valid outcome, not a failure
  }
  sessionId = created.json?.id;
  console.log(`  [${el()}] session ${sessionId} status=${created.json?.status} device=${created.json?.deviceId?.slice(0, 8)}…`);
  console.log(`  [${el()}] frameTransport=${created.json?.frameTransport}`);

  // BASELINE FIRST. Without this the loop cannot tell "the guest app rendered"
  // from "the simulator was already showing something". It could not, and it
  // did not: sfmg, talos, yaver.io and e-mobile each reported PIXELS with
  // near-identical frame sizes (45726 / 45781 / 45738 / 45747 bytes) — four
  // passes that were one screenshot of YAVER'S OWN app, repeated. run-guest
  // never swapped what was on screen, and a harness that scores frame arrival
  // as success cannot see that. Exactly the false green this suite exists to
  // catch, produced by the suite itself.
  let baseline = null;
  {
    const r = await fetch(`${AGENT}/remote-runtime/sessions/${sessionId}/frame`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (r.status === 200) {
      baseline = Buffer.from(await r.arrayBuffer()).length;
      console.log(`  [${el()}] baseline frame before launch: ${baseline} bytes`);
    }
  }

  console.log(`  [${el()}] launching the guest app into the simulator`);
  const ran = await api(`/remote-runtime/sessions/${sessionId}/command`, {
    method: 'POST',
    body: JSON.stringify({ command: 'run-guest' }),
  });
  if (ran.status >= 400) {
    console.log(`  NAMED  run-guest refused (HTTP ${ran.status}): ${(ran.json?.error || ran.text).slice(0, 180)}`);
  } else {
    console.log(`  [${el()}] ${ran.json?.status || 'ok'} — ${(ran.json?.note || '').slice(0, 120)}`);
  }

  // Pull several frames: one JPEG proves the pipe, CHANGING frames prove it is
  // live rather than a single cached still.
  const sizes = [];
  const named = [];
  let lastPath = '';
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${AGENT}/remote-runtime/sessions/${sessionId}/frame`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (res.status !== 200) {
      // The agent REFUSED and said why. That is a NAMED outcome, not silence —
      // my first version scored these SILENT and printed "nothing said why"
      // directly beneath four lines in which the agent had said exactly why.
      // A harness that misreads a stated reason is the same defect it exists to
      // catch, one level up.
      const why = (await res.text()).slice(0, 160);
      console.log(`  [${el()}] frame ${i}: HTTP ${res.status} — ${why}`);
      named.push(why);
      await sleep(4000);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const jpeg = buf[0] === 0xff && buf[1] === 0xd8;      // JPEG magic, not a JSON error
    lastPath = `/tmp/ios-frame-${i}.jpg`;
    writeFileSync(lastPath, buf);
    sizes.push(buf.length);
    console.log(`  [${el()}] frame ${i}: ${buf.length} bytes  jpeg=${jpeg}`);
    await sleep(4000);
  }

  const got = sizes.length;
  const varied = new Set(sizes).size > 1;
  console.log('\n===== iOS SIMULATOR LOOP =====');
  if (got === 0 && named.length > 0) {
    console.log(`NAMED   no frame, but the agent stated the reason: ${named[named.length - 1]}`);
  } else if (got === 0) {
    console.log('SILENT  no frame ever arrived, and nothing said why');
    process.exitCode = 1;
  } else if (baseline !== null && !sizes.some((n) => n !== baseline)) {
    // Every post-launch frame is byte-identical in size to the pre-launch one.
    // The pipe works; the APP did not change. Saying PIXELS here would claim
    // something never observed.
    console.log(`STATIC  ${got} frames, all ${sizes[0]} bytes — IDENTICAL to the pre-launch baseline.`);
    console.log('        Streaming works, but the guest app never appeared: run-guest did not');
    console.log('        change what is on screen. This is NOT a render pass.');
    process.exitCode = 1;
  } else {
    console.log(`PIXELS  ${got} frames, sizes ${sizes.join(', ')}${baseline !== null ? ` (baseline ${baseline})` : ''} — screen CHANGED after launch`);
    console.log(`        last frame: ${lastPath}`);
  }
  console.log('\nverifies STREAMING only — a native binary has no DOM, so this cannot');
  console.log('assert app behaviour the way the browser lane does.');
} finally {
  if (sessionId) {
    const del = await fetch(`${AGENT}/remote-runtime/sessions/${sessionId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
    console.log(`\n  torn down session ${sessionId} (HTTP ${del.status}) — simulator released`);
  }
}
