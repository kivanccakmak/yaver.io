import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { readFileSync } from 'fs';
const env = Object.fromEntries(readFileSync('.env.test','utf8').split('\n').filter(l=>l.includes('=')).map(l=>[l.slice(0,l.indexOf('=')).trim(),l.slice(l.indexOf('=')+1).trim()]));
const b = await chromium.launch(); const p = await (await b.newContext()).newPage();
await p.goto('https://yaver.io/auth',{waitUntil:'domcontentloaded'});
await p.getByPlaceholder('Email address').fill(env.YAVER_TEST_EMAIL);
await p.getByPlaceholder('Password').fill(env.YAVER_TEST_PASSWORD);
await p.getByRole('button',{name:/^sign in$/i}).click();
await p.waitForURL(/\/(survey|dashboard)/,{timeout:30000});
await new Promise(r=>setTimeout(r,7000));
const out = await p.evaluate(async () => {
  const tok = localStorage.getItem('yaver_auth_token');
  const rp  = localStorage.getItem('yaver:userRelayPassword');
  const r = await fetch('https://perceptive-minnow-557.eu-west-1.convex.site/devices/list', { headers:{ Authorization:`Bearer ${tok}` }});
  const d = await r.json();
  const box = (d.devices||[]).find(x => /ubuntu-4gb/i.test(x.name||''));
  return { tok, rp, id: box?.id || box?.deviceId, name: box?.name, online: box?.isOnline };
});
console.log(JSON.stringify({ id: out.id, name: out.name, online: out.online, hasTok: !!out.tok, hasRp: !!out.rp }));
// Ask the box for its disk via the relay.
const res = await p.evaluate(async ({ tok, rp, id }) => {
  const base = `https://public.yaver.io/d/${id}`;
  const H = { 'Content-Type':'application/json', Authorization:`Bearer ${tok}`, 'X-Relay-Password': rp || '' };
  const out = [];
  // GET /ops may enumerate verbs
  { const r0 = await fetch(`${base}/info`, { headers: H }); const j0 = await r0.json();
     out.push(['/info', r0.status, JSON.stringify(j0)]); }
  for (const [verb, payload] of [['run',{command:"PID=$(pgrep -f 'yaver serve'|head -1); echo pid=$PID; tr '\0' '\n' < /proc/$PID/environ | grep ^PATH=", timeoutSec:60}]]) {
    try { const r = await fetch(`${base}/ops`, { method:'POST', headers:H, body: JSON.stringify({ verb, payload }) });
      out.push([verb, r.status, await r.text()]); } catch(e){ out.push([verb,'err',String(e)]); }
  }
  return out;
}, out);
for (const r of res) { console.log(r[0], '->', r[1]); writeFileSync(r[0]==='/info'?'/tmp/info.json':'/tmp/scan.json', String(r[2])); }
await b.close();
