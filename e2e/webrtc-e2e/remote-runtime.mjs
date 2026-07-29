#!/usr/bin/env node
// remote-runtime.mjs <target-id> — closed-loop remote-runtime WebRTC probe.
//
// Drives the same contract as RemoteRuntimeViewer.tsx:
//   POST /remote-runtime/sessions
//   browser RTCPeerConnection offer with recvonly video
//   POST /remote-runtime/sessions/<id>/webrtc/offer
//   receive either RTP <video> pixels or JPEG bytes on the "frames" DataChannel
//   DELETE /remote-runtime/sessions/<id>
//
// Intended dogfood topology for simulator lanes:
//   remote box: Mac with Xcode/simulators
//   client: Ubuntu Chromium

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { chromium } from "playwright";

const TARGET = process.argv[2] || "ios-simulator";
const BASE = (process.env.YAVER_WEBRTC_BASE || "http://127.0.0.1:18080").replace(/\/$/, "");
const WORK_DIR = process.env.YAVER_RUNTIME_WORKDIR || process.cwd();
const FRAMEWORK = process.env.YAVER_RUNTIME_FRAMEWORK || "react-native";
const OUT = process.env.YAVER_OUT_DIR || `/tmp/yaver-rr-webrtc-${TARGET}`;
const DWELL_MS = Number(process.env.YAVER_WEBRTC_RECORD_DWELL_MS || 3500);
const NO_VIDEO = process.env.YAVER_RUNTIME_NO_VIDEO === "1";
const PIXEL_TIMEOUT_MS = Number(process.env.YAVER_WEBRTC_PIXEL_TIMEOUT_MS || defaultPixelTimeout(TARGET));
const PLAYWRIGHT_VIDEO = process.env.YAVER_WEBRTC_NATIVE_VIDEO === "1";
const CONTROL_NAVIGATE_URL = (process.env.YAVER_RUNTIME_CONTROL_NAVIGATE_URL || "").trim();
const EXPECT_BROWSER_LOGS = (process.env.YAVER_RUNTIME_EXPECT_BROWSER_LOGS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

function token() {
  const env = (process.env.YAVER_WEBRTC_TOKEN || "").trim();
  if (env) return env;
  const cfg = JSON.parse(readFileSync(join(homedir(), ".yaver", "config.json"), "utf8"));
  return cfg.auth_token || cfg.token || "";
}
const TOKEN = token();
if (!TOKEN) throw new Error("missing token; set YAVER_WEBRTC_TOKEN");

function defaultPixelTimeout(target) {
  switch (target) {
    case "visionos-simulator":
      return 60_000;
    case "tvos-simulator":
    case "watchos-simulator":
      return 45_000;
    default:
      return 25_000;
  }
}

async function agent(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  return { res, body, text };
}

function serveReceiver() {
  const html = `<!doctype html><meta charset=utf-8><style>
html,body{margin:0;background:#000;height:100%;overflow:hidden}
#v,#img{width:100vw;height:100vh;object-fit:contain;background:#000}
#img{display:none}
</style><video id=v autoplay playsinline muted></video><img id=img>
<script>
window.__yv={offer:null,transport:null,events:[],channels:[],mode:null,ice:null,err:null,video:false,img:false};
let pc=null,lastBlob=null;
const jpegChunks=new Map();
function jpegBlobFromMessage(data){
  if(typeof data!=="string") return new Blob([data],{type:"image/jpeg"});
  let payload=null;
  try{ payload=JSON.parse(data); }catch{ return null; }
  if(!payload||payload.type!=="jpeg-chunk"||!payload.id||typeof payload.index!=="number"||typeof payload.total!=="number"||typeof payload.data!=="string") return null;
  const entry=jpegChunks.get(payload.id)||{total:payload.total,parts:[]};
  entry.total=payload.total; entry.parts[payload.index]=payload.data; jpegChunks.set(payload.id,entry);
  if(entry.parts.filter(Boolean).length<entry.total) return null;
  jpegChunks.delete(payload.id);
  const raw=atob(entry.parts.join(""));
  const bytes=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++) bytes[i]=raw.charCodeAt(i);
  return new Blob([bytes],{type:"image/jpeg"});
}
function waitIce(resolve){
  if(pc.iceGatheringState==="complete") return resolve(pc.localDescription.sdp);
  pc.onicegatheringstatechange=function(){ if(pc.iceGatheringState==="complete") resolve(pc.localDescription.sdp); };
  setTimeout(function(){ resolve(pc.localDescription.sdp); },3500);
}
window.makeOffer=function(){
  return new Promise(function(resolve,reject){
    try{
      pc=new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
      if(!${JSON.stringify(NO_VIDEO)}){
        pc.addTransceiver("video",{direction:"recvonly"});
      }
      pc.createDataChannel("primer");
      pc.ontrack=function(e){ window.__yv.mode="rtp"; window.__yv.video=true; document.getElementById("v").srcObject=e.streams[0]; };
      pc.oniceconnectionstatechange=function(){ window.__yv.ice=pc.iceConnectionState; };
      pc.ondatachannel=function(e){
        const ch=e.channel;
        window.__yv.channels.push(ch.label);
        ch.onopen=function(){ window.__yv.channels.push(ch.label+":open"); };
        ch.onerror=function(){ window.__yv.channels.push(ch.label+":error"); };
        ch.onclose=function(){ window.__yv.channels.push(ch.label+":close"); };
        if(ch.label==="events"){
          ch.onmessage=function(msg){ try{ window.__yv.events.push(JSON.parse(String(msg.data))); }catch{} };
        }
        if(ch.label==="frames"){
          ch.binaryType="arraybuffer";
          ch.onmessage=function(msg){
            const blob=jpegBlobFromMessage(msg.data);
            if(!blob) return;
            window.__yv.mode="jpeg-dc";
            if(lastBlob) URL.revokeObjectURL(lastBlob);
            lastBlob=URL.createObjectURL(blob);
            const img=document.getElementById("img");
            img.onload=function(){ window.__yv.img=true; };
            img.src=lastBlob; img.style.display="block";
          };
        }
      };
      pc.createOffer().then(o=>pc.setLocalDescription(o)).then(()=>waitIce(resolve)).catch(reject);
    }catch(e){ window.__yv.err=String(e); reject(e); }
  });
};
window.applyAnswer=function(sdp,transport){ window.__yv.transport=transport||null; return pc.setRemoteDescription({type:"answer",sdp}); };
window.readPixel=function(){
  const video=document.getElementById("v"), img=document.getElementById("img");
  let el=null,w=0,h=0;
  if(video.videoWidth&&video.videoHeight){ el=video; w=video.videoWidth; h=video.videoHeight; }
  else if(img.complete&&img.naturalWidth&&img.naturalHeight){ el=img; w=img.naturalWidth; h=img.naturalHeight; }
  if(!el) return null;
  const c=document.createElement("canvas"); c.width=w; c.height=h;
  const ctx=c.getContext("2d"); ctx.drawImage(el,0,0,w,h);
  const d=ctx.getImageData(w>>1,h>>1,1,1).data;
  return {r:d[0],g:d[1],b:d[2],w,h,mode:window.__yv.mode,transport:window.__yv.transport,events:window.__yv.events};
};
</script>`;
  const server = http.createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function startRecorder(page, target) {
  const dir = join(OUT, "frames");
  mkdirSync(dir, { recursive: true });
  let n = 0, stopped = false, busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      n += 1;
      await page.screenshot({ path: join(dir, `frame_${String(n).padStart(4, "0")}.png`) });
    } catch {
      n -= 1;
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, 250);
  void tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    while (busy) await new Promise((r) => setTimeout(r, 20));
    if (n <= 0) return "";
    const out = join(OUT, `${target}.mp4`);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-framerate", "4", "-i", join(dir, "frame_%04d.png"), "-vf", "format=yuv420p", "-movflags", "+faststart", out]);
    return out;
  };
}

async function waitPixel(page, ms) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => window.readPixel());
    if (last) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
}

async function waitEventsOpen(page, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const open = await page.evaluate(() => window.__yv.channels.includes("events:open"));
    if (open) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function waitBrowserLogs(page, needles, ms) {
  const deadline = Date.now() + ms;
  let events = [];
  while (Date.now() < deadline) {
    events = await page.evaluate(() => window.__yv.events.filter((e) => e && e.type === "browser-log"));
    const joined = events.map((e) => String(e.message || "")).join("\n");
    if (needles.every((needle) => joined.includes(needle))) return events;
    await new Promise((r) => setTimeout(r, 250));
  }
  return events;
}

let sessionID = "";
const server = await serveReceiver();
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YAVER_CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  ...(PLAYWRIGHT_VIDEO ? { recordVideo: { dir: join(OUT, "videos"), size: { width: 1280, height: 800 } } } : {}),
});
const stopRecording = startRecorder(page, TARGET);

try {
  console.log(`remote-runtime-webrtc · base=${BASE} · target=${TARGET} · workDir=${WORK_DIR}`);
  const create = await agent("/remote-runtime/sessions", {
    method: "POST",
    body: JSON.stringify({ workDir: WORK_DIR, framework: FRAMEWORK, targetId: TARGET, transportMode: "direct-webrtc" }),
  });
  console.log(`create HTTP ${create.res.status} ${JSON.stringify(create.body || create.text).slice(0, 320)}`);
  if (!create.res.ok) {
    console.log(`VERDICT=NAMED · create failed for ${TARGET}`);
    process.exitCode = 2;
  } else {
    sessionID = create.body.id;
    const port = server.address().port;
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded", timeout: 15000 });
    const offer = await page.evaluate(() => window.makeOffer());
    const answer = await agent(`/remote-runtime/sessions/${sessionID}/webrtc/offer`, {
      method: "POST",
      body: JSON.stringify({ type: "offer", sdp: offer }),
    });
    console.log(`offer HTTP ${answer.res.status} ${JSON.stringify(answer.body || answer.text).slice(0, 320)}`);
    if (!answer.res.ok || !answer.body?.answer?.sdp) {
      console.log(`VERDICT=NAMED · offer failed for ${TARGET}`);
      process.exitCode = 3;
    } else {
      await page.evaluate(({ sdp, transport }) => window.applyAnswer(sdp, transport), {
        sdp: answer.body.answer.sdp,
        transport: answer.body.transport,
      });
      if (CONTROL_NAVIGATE_URL) {
        const eventsOpen = await waitEventsOpen(page, 10_000);
        console.log(`events-channel ${eventsOpen ? "open" : "not-open"}`);
        const nav = await agent(`/remote-runtime/sessions/${sessionID}/control`, {
          method: "POST",
          body: JSON.stringify({ action: "navigate", url: CONTROL_NAVIGATE_URL }),
        });
        console.log(`navigate HTTP ${nav.res.status} ${JSON.stringify(nav.body || nav.text).slice(0, 320)}`);
        if (!nav.res.ok) {
          console.log(`VERDICT=NAMED · navigate failed for ${TARGET}`);
          process.exitCode = 5;
        }
      }
      const px = await waitPixel(page, PIXEL_TIMEOUT_MS);
      if (EXPECT_BROWSER_LOGS.length > 0 && process.exitCode === undefined) {
        const logs = await waitBrowserLogs(page, EXPECT_BROWSER_LOGS, 15_000);
        const compact = logs.map((e) => `${e.level || ""}:${e.source || ""}:${String(e.message || "").slice(0, 160)}`);
        console.log(`browser-logs ${JSON.stringify(compact)}`);
        const joined = logs.map((e) => String(e.message || "")).join("\n");
        const missing = EXPECT_BROWSER_LOGS.filter((needle) => !joined.includes(needle));
        if (missing.length > 0) {
          console.log(`VERDICT=SILENT · ${TARGET}:missing-browser-log:${missing.join("|")}`);
          process.exitCode = 6;
        }
      }
      await new Promise((r) => setTimeout(r, DWELL_MS));
      if (px) {
        console.log(`PIXELS ${JSON.stringify(px)}`);
        if (process.exitCode === undefined) {
          console.log(`VERDICT=PIXELS · ${TARGET}:${px.mode || "unknown"}:${px.transport || "unknown"}`);
        }
      } else {
        const state = await page.evaluate(() => window.__yv);
        console.log(`SILENT ${JSON.stringify(state).slice(0, 500)}`);
        console.log(`VERDICT=SILENT · ${TARGET}`);
        process.exitCode = 4;
      }
    }
  }
} finally {
  const mp4 = await stopRecording().catch(() => "");
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
  server.close();
  if (sessionID) {
    const del = await agent(`/remote-runtime/sessions/${sessionID}`, { method: "DELETE" }).catch((e) => ({ res: { status: 0 }, text: String(e) }));
    console.log(`delete HTTP ${del.res.status}`);
  }
  if (mp4) console.log(`recording ${mp4}`);
}
