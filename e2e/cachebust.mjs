import { chromium } from '@playwright/test';
import { readFileSync } from 'fs';
const env=Object.fromEntries(readFileSync('/Users/kivanccakmak/Workspace/yaver.io/.env.test','utf8').split('\n').filter(l=>l.includes('=')).map(l=>[l.slice(0,l.indexOf('=')).trim(),l.slice(l.indexOf('=')+1).trim()]));
const b=await chromium.launch(); const p=await (await b.newContext()).newPage();
await p.goto('https://yaver.io/auth',{waitUntil:'domcontentloaded'});
await p.getByPlaceholder('Email address').fill(env.YAVER_TEST_EMAIL);
await p.getByPlaceholder('Password').fill(env.YAVER_TEST_PASSWORD);
await p.getByRole('button',{name:/^sign in$/i}).click();
await p.waitForURL(/\/(survey|dashboard)/,{timeout:30000});
const tok=await p.evaluate(()=>localStorage.getItem('yaver_auth_token'));
const o=await p.evaluate(async(t)=>{
  const C='https://perceptive-minnow-557.eu-west-1.convex.site';
  const get=async(u,h)=>{const r=await fetch(u,{headers:h,cache:'no-store'});const j=await r.json();
    return {cc:r.headers.get('cache-control'),age:r.headers.get('age'),
      pw:(j.relayServers||[]).map(s=>typeof s.password==='string'?`len${s.password.length}`:'none')};};
  return {
    plain: await get(`${C}/config`,{Authorization:`Bearer ${t}`}),
    busted: await get(`${C}/config?cb=${Math.random()}`,{Authorization:`Bearer ${t}`}),
  };
},tok);
console.log(JSON.stringify(o,null,1));
await b.close();
