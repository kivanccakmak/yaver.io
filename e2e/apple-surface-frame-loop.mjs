/**
 * Apple simulator surface probe: create a remote-runtime session, capture real
 * frames, and report whether launch is supported for that target.
 *
 * This intentionally does not claim app behaviour. tvOS/watchOS/visionOS share
 * the Apple simulator attach/capture target today, but `run-guest` only exists
 * for RN iOS simulator sessions. A frame proves the WebRTC/JPEG capture lane;
 * a named launch refusal proves the missing route is visible instead of silent.
 */
import { writeFileSync } from 'node:fs';

const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:18080';
const TOKEN = (process.env.YAVER_AGENT_TOKEN || '').trim();
const WORKDIR = process.env.WORKDIR || process.cwd();
const FRAMEWORK = process.env.FRAMEWORK || 'swift';
const TARGET = process.env.TARGET_ID || 'tvos-simulator';
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
const started = Date.now();
const el = () => `${Math.round((Date.now() - started) / 1000)}s`;

try {
  console.log(`──── ${TARGET} · ${WORKDIR.split('/').pop()} ────`);
  const caps = await api(`/remote-runtime/capabilities?workDir=${encodeURIComponent(WORKDIR)}&framework=${encodeURIComponent(FRAMEWORK)}&refresh=1`);
  const target = caps.json?.targets?.find((t) => t.id === TARGET);
  if (!target) {
    console.log(`NAMED   target ${TARGET} is not offered for this project`);
    process.exit(0);
  }
  if (!target.enabled) {
    console.log(`NAMED   target disabled: ${target.reason || 'no reason returned'}`);
    process.exit(0);
  }
  console.log(`  [${el()}] target enabled surface=${target.surface || ''} label=${target.label || ''}`);

  const created = await api('/remote-runtime/sessions', {
    method: 'POST',
    body: JSON.stringify({ framework: FRAMEWORK, workDir: WORKDIR, targetId: TARGET }),
  });
  if (created.status >= 400) {
    console.log(`NAMED   create refused (HTTP ${created.status}): ${(created.json?.error || created.text).slice(0, 220)}`);
    process.exit(0);
  }
  sessionId = created.json?.id;
  console.log(`  [${el()}] session ${sessionId} status=${created.json?.status} device=${created.json?.deviceId?.slice(0, 8)}…`);
  console.log(`  [${el()}] dims=${created.json?.deviceDims?.width || '?'}x${created.json?.deviceDims?.height || '?'} ${created.json?.deviceDims?.rotation || ''}`);

  const launched = await api(`/remote-runtime/sessions/${sessionId}/command`, {
    method: 'POST',
    body: JSON.stringify({ command: 'run-guest' }),
  });
  if (launched.status >= 400) {
    console.log(`  NAMED  run-guest unsupported/refused: ${(launched.json?.error || launched.text).slice(0, 220)}`);
  } else {
    console.log(`  [${el()}] run-guest accepted status=${launched.json?.status || 'ok'}`);
  }

  const sizes = [];
  const named = [];
  let lastPath = '';
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${AGENT}/remote-runtime/sessions/${sessionId}/frame`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (res.status !== 200) {
      const why = (await res.text()).slice(0, 220);
      console.log(`  [${el()}] frame ${i}: HTTP ${res.status} — ${why}`);
      named.push(why);
      await sleep(3000);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const jpeg = buf[0] === 0xff && buf[1] === 0xd8;
    lastPath = `/tmp/yaver-${TARGET}-frame-${i}.jpg`;
    writeFileSync(lastPath, buf);
    sizes.push(buf.length);
    console.log(`  [${el()}] frame ${i}: ${buf.length} bytes jpeg=${jpeg}`);
    await sleep(3000);
  }

  console.log('\n===== APPLE SURFACE FRAME LOOP =====');
  if (sizes.length === 0 && named.length > 0) {
    console.log(`NAMED   no frame, but the agent stated the reason: ${named[named.length - 1]}`);
  } else if (sizes.length === 0) {
    console.log('SILENT  no frame arrived after an enabled target created a session and no reason was surfaced');
    process.exitCode = 1;
  } else {
    console.log(`PIXELS  ${sizes.length} frames, sizes ${sizes.join(', ')}; last frame ${lastPath}`);
  }
} finally {
  if (sessionId) {
    const del = await fetch(`${AGENT}/remote-runtime/sessions/${sessionId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
    console.log(`\n  torn down session ${sessionId} (HTTP ${del.status})`);
  }
}
