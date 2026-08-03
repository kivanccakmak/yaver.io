/**
 * _framePixels.mjs — turn a captured FRAME into the same pixel verdict the
 * browser arcs reach, for every surface that has no DOM.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * The web arc samples pixels through a canvas: `getImageData(x, y, 1, 1)` in a
 * real browser. tvOS, visionOS, watchOS, Wear OS and the car surface have no
 * browser to borrow, so their evidence is a PNG the agent captured
 * (`/vibing/preview/frames/{hash}` — chromedp screenshots, written to disk as
 * `<hash>.png`).
 *
 * The first draft of the TV arc did this instead:
 *
 *     const px = Array.from(new Uint8Array(buf));      // ← a PNG file
 *     for (let i = 0; i + 2 < px.length; i += 3) triples.push([px[i], …]);
 *     return classifyVibeColor(triples);
 *
 * Two independent defects stacked, and NEITHER could ever have been noticed by
 * reading the output:
 *
 *   1. `buf` is a compressed PNG — IHDR, zlib-deflated IDAT, CRCs. Walking it
 *      three bytes at a time samples the compression stream, not the image.
 *      Every "colour" it produced was noise that happened to be shaped like a
 *      colour.
 *   2. `classifyVibeColor` takes a FLAT [r,g,b]. Handing it an array OF triples
 *      destructures three ARRAYS into r/g/b, fails the `typeof v !== "number"`
 *      guard, and returns "unknown" — every time, for every frame, forever.
 *
 * So the tvOS/visionOS colour verdict was structurally incapable of passing,
 * and would have burned a 12-minute budget per run reporting a confident,
 * meaningless failure. This is the exact class CLAUDE.md names: a test that is
 * wrong in the direction of FAILURE sends real investigations after systems
 * that work.
 *
 * ── Dependency-free on purpose ─────────────────────────────────────────────
 *
 * `pngjs` and `sharp` are both installed — under `web/node_modules`, which is
 * not on the resolution path from `e2e/`, and reaching across with a relative
 * path into another workspace's node_modules is a break waiting for the next
 * `npm ci`. Node ships `zlib`, and a Chrome screenshot is the simplest PNG
 * there is: 8-bit, non-interlaced. The decoder below is ~100 lines and has a
 * round-trip self-test (`_framePixels.test.mjs`), which is a better guarantee
 * than an unpinned transitive dependency.
 *
 * ── Never guess a pixel ────────────────────────────────────────────────────
 *
 * Anything this decoder does not genuinely support THROWS with the reason
 * named. Returning a plausible-looking buffer for an interlaced or 16-bit PNG
 * would recreate defect #1 with better manners.
 */
import zlib from "node:zlib";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Bytes per complete pixel, by PNG colour type, at bit depth 8. */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Decode a PNG into straight RGBA.
 *
 * Supports bit depth 8, non-interlaced, colour types 0/2/3/4/6 — which covers
 * everything Chrome's `Page.captureScreenshot` emits (type 6) plus the common
 * hand-made cases. Throws, with the specific unsupported property named, for
 * anything else.
 *
 * @param {Buffer|ArrayBuffer|Uint8Array} input
 * @returns {{width:number,height:number,rgba:Buffer}}
 */
export function decodePng(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error(
      `not a PNG (first bytes ${[...buf.subarray(0, 8)].map((b) => b.toString(16)).join(" ")}) — ` +
      `the frame endpoint returned something else`,
    );
  }

  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idat = [];

  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len; // length + type + data + crc

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") {
      palette = Buffer.from(data);
    } else if (type === "tRNS") {
      trns = Buffer.from(data);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
  }

  if (!(width > 0 && height > 0)) throw new Error("PNG has no IHDR / zero dimensions");
  if (depth !== 8) throw new Error(`PNG bit depth ${depth} unsupported (only 8) — refusing to guess pixels`);
  if (interlace !== 0) throw new Error("interlaced (Adam7) PNG unsupported — refusing to guess pixels");
  if (!(colorType in CHANNELS)) throw new Error(`PNG colour type ${colorType} unsupported`);
  if (colorType === 3 && !palette) throw new Error("indexed PNG with no PLTE chunk");
  if (!idat.length) throw new Error("PNG has no IDAT data");

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = CHANNELS[colorType];
  const stride = width * channels;

  // Undo the per-scanline filters. Each scanline is prefixed with a filter
  // byte and is reconstructed against the already-reconstructed line above,
  // so this must run in order and cannot be parallelised.
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride); // an implicit all-zero row above line 0
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    if (base + stride >= raw.length + 1 && base + 1 + stride > raw.length) {
      throw new Error(`PNG truncated at scanline ${y} of ${height}`);
    }
    const filter = raw[base];
    const line = raw.subarray(base + 1, base + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    unfilter(filter, line, cur, prev, channels);
    prev = cur;
  }

  // Widen whatever we decoded to straight RGBA, so callers only ever see one
  // shape regardless of how the frame happened to be encoded.
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++) {
    const s = i * channels;
    let r;
    let g;
    let b;
    let a = 255;
    switch (colorType) {
      case 0: r = g = b = out[s]; break;
      case 4: r = g = b = out[s]; a = out[s + 1]; break;
      case 2: r = out[s]; g = out[s + 1]; b = out[s + 2]; break;
      case 6: r = out[s]; g = out[s + 1]; b = out[s + 2]; a = out[s + 3]; break;
      case 3: {
        const idx = out[s] * 3;
        r = palette[idx]; g = palette[idx + 1]; b = palette[idx + 2];
        if (trns && out[s] < trns.length) a = trns[out[s]];
        break;
      }
      default: throw new Error(`unreachable colour type ${colorType}`);
    }
    rgba[p++] = r; rgba[p++] = g; rgba[p++] = b; rgba[p++] = a;
  }

  return { width, height, rgba };
}

function unfilter(filter, line, cur, prev, bpp) {
  const n = line.length;
  switch (filter) {
    case 0:
      line.copy(cur);
      break;
    case 1: // Sub
      for (let i = 0; i < n; i++) cur[i] = (line[i] + (i >= bpp ? cur[i - bpp] : 0)) & 0xff;
      break;
    case 2: // Up
      for (let i = 0; i < n; i++) cur[i] = (line[i] + prev[i]) & 0xff;
      break;
    case 3: // Average
      for (let i = 0; i < n; i++) {
        const left = i >= bpp ? cur[i - bpp] : 0;
        cur[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff;
      }
      break;
    case 4: // Paeth
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        cur[i] = (line[i] + pred) & 0xff;
      }
      break;
    default:
      throw new Error(`unknown PNG filter type ${filter} — refusing to guess pixels`);
  }
}

/**
 * Sample a decoded frame at the SAME grid the web arc uses, and return the
 * samples in the SAME shape the shared classifier expects.
 *
 * The grid, not one row, is load-bearing and was paid for: a single horizontal
 * band at 55% height ran straight through the sign-in buttons (#1a1a1a), so a
 * fully red login screen sampled as "black" and two twelve-minute runs reported
 * failure for a vibe that had succeeded (see web/lib/vibeVerdict.ts).
 *
 * @param {{width:number,height:number,rgba:Buffer}} img
 * @param {(w:number,h:number,stride?:number)=>Array<[number,number]>} samplePoints
 * @param {number} stride
 * @returns {number[][]} one [r,g,b] per sample point
 */
export function samplePixels(img, samplePoints, stride = 8) {
  const pts = samplePoints(img.width, img.height, stride);
  const out = [];
  for (const [x, y] of pts) {
    const i = (y * img.width + x) * 4;
    if (i + 2 >= img.rgba.length) continue;
    out.push([img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]]);
  }
  return out;
}
