#!/usr/bin/env node
// run.mjs [webui|mobile|both] — WebRTC RTP video-track closed loop, browser lane.
//
// docs/architecture/E2E_VIBE_CLOSED_LOOP_ALL_SURFACES.md (WebRTC section).
//
// WHY this shape. The guest-app preview WebRTC lanes (ios-simulator via
// xcrun recordVideo, android-emulator via adb screenrecord) cannot produce a
// real RTP video track on a Linux box: iOS capture is macOS-only AND disabled
// (Xcode 26 dropped recordVideo→stdout), an AVD won't boot on a 4 GB arm64 box
// without KVM, and browser-window / android-redroid stream JPEG-over-DataChannel
// (no <video> track at all). The ONE genuine H.264 RTP producer that runs on
// Linux is the decoupled ffmpeg stream lane (desktop/agent/stream_webrtc.go,
// CanEncodeRTPH264 = ffmpegPath() != ""). We drive it with a CONTROLLED test
// pattern so the loop is deterministic and pixel-truthful:
//
//   push a solid-GREEN JPEG   →  POST /stream/push?name=<src>
//   browser offers recvonly   →  makeOffer() (full ICE gather, non-trickle)
//   harness relays signaling   →  POST /stream/webrtc/offer {source, sdp}   (no browser CORS)
//   media flows over ICE       →  ontrack → <video> paints
//   read the CENTER pixel      →  assert GREEN
//   push RED, assert RED        →  the transport carried a real, changing frame
//
// A real RTP track is the ONLY way <video>.videoWidth becomes non-zero; the JPEG
// fallback fills an <img>, never a <video> — so readPixel()!=null is itself proof
// the H.264 track decoded. That is the exact path tvOS/watch/car/AR-VR use.
//
// Two "surfaces", same browser RTCPeerConnection (that is what both really are):
//   webui  — desktop-viewport Chromium (mirrors RemoteRuntimeViewer.tsx)
//   mobile — mobile-viewport Chromium, receiver inside an <iframe> (mirrors
//            remote-runtime.tsx's WebView→srcdoc on the RN-web build)
//
// Env: YAVER_WEBRTC_BASE (http://host:port of the box) overrides auto-resolve.
//      YAVER_WEBRTC_SOURCE (default "yavertest"). Token from ~/.yaver/config.json.

import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, execSync } from "node:child_process";
import http from "node:http";
import { Builder, By } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SURFACE = process.argv[2] || "both";
const SOURCE = process.env.YAVER_WEBRTC_SOURCE || "yavertest";
const OUT = process.env.YAVER_OUT_DIR || "/tmp/yaver-webrtc";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const cfg = JSON.parse(readFileSync(join(homedir(), ".yaver", "config.json"), "utf8"));
const TOKEN = cfg.auth_token;

// Resolve the box HTTP base at RUNTIME (never hardcode infra IPs in a public repo).
function resolveBase() {
  if (process.env.YAVER_WEBRTC_BASE) return process.env.YAVER_WEBRTC_BASE.replace(/\/$/, "");
  const out = execSync("yaver devices 2>/dev/null", { encoding: "utf8" });
  // The primary row carries the reachable host:port in its last column.
  const line = out.split("\n").find((l) => /\bprimary\b/.test(l)) || "";
  const m = line.match(/(\d{1,3}(?:\.\d{1,3}){3}:\d+)/);
  if (!m) throw new Error("could not resolve primary device address — set YAVER_WEBRTC_BASE");
  return `http://${m[1]}`;
}
const BASE = resolveBase();

// Solid-color MJPEG frames matching the box's `-f mjpeg -i pipe:0` input.
function makeFrame(hex, name) {
  const p = join(OUT, name);
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", `color=c=${hex}:s=320x240`,
    "-frames:v", "1", "-f", "mjpeg", p], { stdio: "ignore" });
  return readFileSync(p).toString("base64");
}
// Deliberately AVOID green: an H.264 decoder that never got real content paints
// the all-zero-YUV "no-signal" frame rgb(0,135,0), which a green test color would
// masquerade as. Magenta + blue are both far from it, so a pass REQUIRES real
// decoded content — the no-signal frame matches neither.
const MAGENTA = makeFrame("0xE032B0", "a.jpg");
const BLUE = makeFrame("0x2E52E4", "b.jpg");

async function pushFrame(b64) {
  const res = await fetch(`${BASE}/stream/push?name=${encodeURIComponent(SOURCE)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jpegB64: b64, mime: "image/jpeg" }),
  });
  if (!res.ok) throw new Error(`push failed HTTP ${res.status}`);
}

async function offerToBox(sdp) {
  const res = await fetch(`${BASE}/stream/webrtc/offer`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ source: SOURCE, sdp }),
  });
  const data = await res.json();
  // The decoupled ffmpeg stream lane answers {ok,type:"answer",sdp} directly
  // (it ALWAYS produces an RTP H.264 track — no JPEG fallback on this route).
  if (!res.ok || !data.sdp) throw new Error(`offer failed HTTP ${res.status}: ${JSON.stringify(data).slice(0, 160)}`);
  const transport = /m=video/.test(data.sdp) ? "webrtc-rtp-h264-v1" : "webrtc-none";
  return { answerSdp: data.sdp, transport };
}

function classify(px) {
  if (!px) return "none";
  const { r, g, b } = px;
  // no-signal: the decoder's all-zero-YUV frame (no real content ever decoded).
  if (r < 40 && g > 100 && g < 170 && b < 40) return "nosignal";
  if (r > 110 && b > 90 && g < r - 40 && g < b + 40) return "magenta"; // r+b, low g
  if (b > 120 && b > r + 40 && b > g + 40) return "blue";
  return `other(${r},${g},${b})`;
}

// Serve receiver.html locally so it loads over http (WebRTC needs a secure-ish
// context; http://localhost qualifies). Media still flows box↔browser over ICE.
function serveReceiver() {
  const html = readFileSync(join(HERE, "receiver.html"), "utf8");
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/mobile")) {
      // Mirror the RN-web WebView: the receiver runs inside an <iframe srcdoc>.
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><meta name=viewport content="width=device-width">
        <style>html,body{margin:0;background:#000}iframe{border:0;width:320px;height:240px}</style>
        <iframe id="f" srcdoc='${html.replace(/'/g, "&#39;")}'></iframe>`);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSurface(driver, surface, server) {
  const port = server.address().port;
  const url = surface === "mobile" ? `http://127.0.0.1:${port}/mobile` : `http://127.0.0.1:${port}/`;
  await driver.get(url);
  await sleep(500);

  // In the mobile framing the receiver lives inside the <iframe> — drive that
  // window's globals so the SAME contract (makeOffer/applyAnswer/readPixel) works.
  const ctx = surface === "mobile" ? "document.getElementById('f').contentWindow" : "window";

  // A pushed stream source is only "live" while frames keep arriving
  // (pushedFreshWindow = 12s, desktop/agent/stream_push.go) and the encoder
  // feeds the LATEST frame — so a real source pushes CONTINUOUSLY, and a color
  // change is just the buffer's next frame. Mirror that: a background pusher
  // keeps the current color flowing; flipping `cur` flips the picture.
  let cur = MAGENTA, pushing = true;
  (async () => { while (pushing) { try { await pushFrame(cur); } catch {} await sleep(600); } })();
  await sleep(400); // let the first frame land before the encoder starts

  const offer = await driver.executeAsyncScript(
    `const cb=arguments[arguments.length-1];(${ctx}).makeOffer().then(cb).catch(e=>cb('ERR:'+e));`);
  if (typeof offer === "string" && offer.startsWith("ERR:")) { pushing = false; throw new Error(`makeOffer ${offer}`); }

  const ans = await offerToBox(offer);
  await driver.executeScript(
    `(${ctx}).applyAnswer(arguments[0], arguments[1]);`, ans.answerSdp, ans.transport || "");

  // Poll for a painted frame of the wanted color (real H.264 decode → non-zero
  // videoWidth; the all-zero-YUV "no-signal" frame reads rgb(0,135,0) = neither).
  async function waitColor(want, ms) {
    const end = Date.now() + ms;
    let last = "none";
    while (Date.now() < end) {
      const px = await driver.executeScript(`return (${ctx}).readPixel();`);
      last = classify(px);
      if (last === want) return { ok: true, px };
      await sleep(700);
    }
    return { ok: false, last };
  }

  const g = await waitColor("magenta", 25000);
  let rres = { ok: false, last: "skipped" };
  if (g.ok) { cur = BLUE; rres = await waitColor("blue", 20000); } // flip the live source
  // On any miss, capture the decode-vs-receive evidence so the verdict is never
  // a bare "no pixels" — it says WHY (decoded to green? never decoded?).
  let stats = null;
  if (!g.ok || !rres.ok) {
    stats = await driver.executeAsyncScript(`const cb=arguments[arguments.length-1];(${ctx}).getStats().then(cb).catch(()=>cb(null));`).catch(() => null);
  }
  pushing = false;

  const transport = ans.transport || "(none)";
  const iceState = await driver.executeScript(`return (${ctx}).__yv && (${ctx}).__yv.ice;`).catch(() => null);
  const pass = g.ok && rres.ok && transport.includes("rtp-h264");
  // "no-signal" = frames decode but only to the all-zero-YUV green — the content
  // bug (encode delivered empty frames), distinct from "never decoded" (transport).
  const noSignal = stats && stats.framesDecoded > 0 && !g.ok;
  const st = stats ? ` [rx=${stats.packetsReceived} dec=${stats.framesDecoded} kf=${stats.keyFramesDecoded} lost=${stats.packetsLost}]` : "";
  let verdict, reason;
  if (pass) { verdict = "PIXELS"; reason = `magenta→blue decoded on ${transport}`; }
  else if (noSignal) { verdict = "SILENT"; reason = `frames decode but to all-zero-YUV green — encode delivered no content (ice=${iceState})${st}`; }
  else if (transport.includes("rtp-h264") && !g.ok) { verdict = "SILENT"; reason = `RTP track but no frame decoded (ice=${iceState})${st}`; }
  else if (!transport.includes("rtp-h264")) { verdict = "NAMED"; reason = `no RTP track — transport=${transport} (ffmpeg/source?)`; }
  else { verdict = "SILENT"; reason = `green=${g.ok} red=${rres.ok} last=${rres.last} (ice=${iceState})${st}`; }

  try { writeFileSync(join(OUT, `${surface}.png`), Buffer.from(await driver.takeScreenshot(), "base64")); } catch {}
  return { surface, verdict, reason, transport };
}

async function main() {
  console.log(`webrtc-e2e · base=${BASE} · source=${SOURCE} · surface=${SURFACE}`);
  const server = await serveReceiver();
  const surfaces = SURFACE === "both" ? ["webui", "mobile"] : [SURFACE];
  const results = [];
  for (const s of surfaces) {
    const w = s === "mobile" ? 420 : 1280;
    const h = s === "mobile" ? 860 : 800;
    const opts = new chrome.Options().addArguments(
      `--window-size=${w},${h}`, "--no-sandbox", "--disable-gpu",
      "--autoplay-policy=no-user-gesture-required");
    if (process.env.HEADED !== "1") opts.addArguments("--headless=new");
    const driver = await new Builder().forBrowser("chrome").setChromeOptions(opts).build();
    try {
      const r = await runSurface(driver, s, server);
      results.push(r);
      console.log(`  [${r.surface}] ${r.verdict} · ${r.reason}`);
    } catch (e) {
      results.push({ surface: s, verdict: "SILENT", reason: `crash: ${e?.message || e}` });
      console.log(`  [${s}] SILENT · crash: ${e?.message || e}`);
    } finally {
      await driver.quit().catch(() => {});
    }
  }
  server.close();
  const allPass = results.length > 0 && results.every((r) => r.verdict === "PIXELS");
  console.log(`VERDICT=${allPass ? "PIXELS" : "FAIL"} · ${results.map((r) => `${r.surface}:${r.verdict}`).join(" ")}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error("fatal:", e); process.exit(2); });
