#!/usr/bin/env node
/**
 * Local "vibing" frame server — for developing/testing the live-frame lane
 * from a simulator without a box that has /vibing/frame yet.
 *
 *   node scripts/vibing-local-frame.mjs [port]
 *
 * Routes:
 *   GET /frame?url=<url>  → a generated PNG whose color shifts every ~2s
 *                           (frames visibly change → proves live rendering).
 *                           Chrome-based capture is avoided for reliability.
 *   GET /sample           → a live HTML page (big clock)
 *
 * In the simulator: set the Vibing screen's "Frame source (dev)" to
 * http://localhost:8787, Start preview, and frames render live.
 */
import { createServer } from "http";
import { deflateSync } from "zlib";

const PORT = Number(process.argv[2] || 8787);
const W = 640;
const H = 360;

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Generate a PNG whose background hue is driven by the current time. */
function generateFrame() {
  const sec = Math.floor(Date.now() / 2000); // shifts every 2s
  const hue = (sec * 37) % 360;
  const h = hue / 60;
  const f = h - Math.floor(h);
  const p = 0, q = 0.35 * (1 - f), t = 0.35 * (1 - (1 - f));
  let r, g, b;
  const hi = Math.floor(h) % 6;
  if (hi === 0) [r, g, b] = [0.35, t, p];
  else if (hi === 1) [r, g, b] = [q, 0.35, p];
  else if (hi === 2) [r, g, b] = [p, 0.35, t];
  else if (hi === 3) [r, g, b] = [p, q, 0.35];
  else if (hi === 4) [r, g, b] = [t, p, 0.35];
  else [r, g, b] = [0.35, p, q];
  const R = Math.round(r * 255), G = Math.round(g * 255), B = Math.round(b * 255);

  // Raw scanlines (filter 0)
  const raw = Buffer.alloc(H * (1 + W * 3));
  const label = new Date().toLocaleTimeString();
  let o = 0;
  for (let y = 0; y < H; y++) {
    raw[o++] = 0;
    for (let x = 0; x < W; x++) {
      raw[o++] = x < 200 ? R : R; // placeholder solid bg
      raw[o++] = G;
      raw[o++] = B;
    }
  }
  void label;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = deflateSync(raw);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const SAMPLE = `<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:0;background:#0d1117;color:#e6edf3;font-family:monospace;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh}</style>
</head><body><h1 style="font-size:90px" id="c">--</h1><h2 style="color:#58a6ff">Yaver Vibing · live frame</h2>
<script>const e=document.getElementById('c');function tick(){const n=new Date();e.textContent=n.toLocaleTimeString()+'.'+String(n.getMilliseconds()).padStart(3,'0')}tick();setInterval(tick,100)</script>
</body></html>`;

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // The web Vibing page sends an Authorization header, so answer its CORS
  // preflight too. Native tvOS does not need this, but sharing the test server
  // keeps both validation paths identical.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Relay-Password");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname === "/sample") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(SAMPLE);
    return;
  }
  if (url.pathname === "/frame") {
    const png = generateFrame();
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
    res.end(png);
    return;
  }
  res.writeHead(404);
  res.end("not found");
}).listen(PORT, () => {
  console.log(`vibing local frame server on http://localhost:${PORT}`);
  console.log(`  sample page: http://localhost:${PORT}/sample`);
  console.log(`  frame api:   http://localhost:${PORT}/frame`);
});
