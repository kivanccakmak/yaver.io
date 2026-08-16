/**
 * _framePixels.test.mjs — prove the frame decoder, by breaking it.
 *
 *   node e2e/_framePixels.test.mjs
 *
 * The decoder exists because the TV/visionOS arc used to read a compressed PNG
 * as if it were RGB triples and classify the noise. That bug was invisible in
 * the output — it produced a confident colour every time. So the decoder does
 * not get to be trusted: it gets round-tripped against images whose exact
 * pixels are known, through every scanline filter, plus negative controls that
 * assert it REFUSES rather than guesses.
 *
 * A guard nobody has watched fail is a guess (CLAUDE.md). Each case below has
 * been run against a deliberately-broken decoder.
 */
import zlib from "node:zlib";
import assert from "node:assert";
import { decodePng, samplePixels } from "./_framePixels.mjs";
import { classifyVibeColor, looksRendered, modalColor, samplePoints } from "../web/lib/vibeVerdict.ts";

// ── A minimal PNG encoder, for fixtures only ────────────────────────────────
// Deliberately NOT sharing code with the decoder: a round-trip through one
// implementation's own assumptions proves nothing. This writes the spec's
// bytes by hand so a decoder bug cannot cancel out against an encoder bug.

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * Encode RGBA pixels as a PNG, applying `filter` to every scanline so each
 * un-filter branch of the decoder is exercised for real.
 */
function encodePng(width, height, rgba, filter = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const bpp = 4;
  const stride = width * bpp;
  const raw = Buffer.alloc(height * (stride + 1));
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const line = rgba.subarray(y * stride, (y + 1) * stride);
    const base = y * (stride + 1);
    raw[base] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = line[i]; break;
        case 1: v = line[i] - a; break;
        case 2: v = line[i] - b; break;
        case 3: v = line[i] - ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = line[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`test encoder: bad filter ${filter}`);
      }
      raw[base + 1 + i] = v & 0xff;
    }
    prev = line;
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function solid(width, height, [r, g, b]) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log("frame decoder");

// ── 1. Every scanline filter round-trips EXACTLY ────────────────────────────
// Not "approximately": a Paeth or Average bug shifts channels by a few counts,
// which is precisely the size of error that still classifies as the right
// colour and hides until some other frame is misread.
for (const filter of [0, 1, 2, 3, 4]) {
  test(`filter ${filter} round-trips exactly`, () => {
    const w = 17; // deliberately not a multiple of anything
    const h = 9;
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = (i * 7) & 0xff;
      rgba[i * 4 + 1] = (i * 13 + 5) & 0xff;
      rgba[i * 4 + 2] = (i * 29 + 11) & 0xff;
      rgba[i * 4 + 3] = 255;
    }
    const img = decodePng(encodePng(w, h, rgba, filter));
    assert.strictEqual(img.width, w);
    assert.strictEqual(img.height, h);
    assert.ok(img.rgba.equals(rgba), "decoded pixels differ from the encoded ones");
  });
}

// ── 2. The verdict a surface actually reaches ───────────────────────────────
// This is the assertion the TV arc depends on. Before the fix it produced
// "unknown" for a solid red frame — an array of triples handed to a classifier
// that takes a flat [r,g,b].
test("a solid red frame classifies as red", () => {
  const img = decodePng(encodePng(200, 120, solid(200, 120, [220, 30, 30])));
  const samples = samplePixels(img, samplePoints, 8);
  assert.ok(samples.length > 10, `expected a grid of samples, got ${samples.length}`);
  assert.strictEqual(classifyVibeColor(modalColor(samples)), "red");
});

test("a solid black frame classifies as black", () => {
  const img = decodePng(encodePng(200, 120, solid(200, 120, [10, 10, 10])));
  assert.strictEqual(classifyVibeColor(modalColor(samplePixels(img, samplePoints, 8))), "black");
});

// NEGATIVE CONTROL for the original bug: hand the RAW FILE BYTES to the same
// pipeline the arc used to use, and prove it cannot reach a colour. If this
// ever starts returning "red", the arc has regressed to reading compressed
// bytes and every verdict it emits is noise again.
test("raw PNG bytes CANNOT masquerade as a colour", () => {
  const png = encodePng(200, 120, solid(200, 120, [220, 30, 30]));
  const bytes = Array.from(new Uint8Array(png));
  const triples = [];
  for (let i = 0; i + 2 < bytes.length; i += 3) triples.push([bytes[i], bytes[i + 1], bytes[i + 2]]);
  assert.strictEqual(
    classifyVibeColor(triples),
    "unknown",
    "the old byte-walking path produced a colour — that is the bug this decoder replaced",
  );
});

// ── 3. An empty panel must not agree with the assertion ─────────────────────
// A blank black rectangle and a black login screen are identical to a sampler.
test("a one-colour frame does not look rendered", () => {
  const img = decodePng(encodePng(200, 120, solid(200, 120, [0, 0, 0])));
  assert.strictEqual(looksRendered(samplePixels(img, samplePoints, 8)), false);
});

test("a frame with real UI does look rendered", () => {
  const w = 200;
  const h = 120;
  const rgba = solid(w, h, [0, 0, 0]);
  // paint a few "controls" in distinct tones
  for (let y = 20; y < 60; y++) {
    for (let x = 20; x < 180; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = 26; rgba[i + 1] = 26; rgba[i + 2] = 26;
    }
  }
  for (let y = 70; y < 100; y++) {
    for (let x = 20; x < 180; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = 240; rgba[i + 1] = 240; rgba[i + 2] = 240;
    }
  }
  assert.strictEqual(looksRendered(samplePixels(decodePng(encodePng(w, h, rgba)), samplePoints, 8)), true);
});

// ── 4. Refuse, never guess ──────────────────────────────────────────────────
// Returning a plausible buffer for an input we do not really support would
// recreate the original defect with better manners.
test("a non-PNG body is named, not decoded", () => {
  assert.throws(() => decodePng(Buffer.from('{"error":"method not allowed"}')), /not a PNG/);
});

test("an interlaced PNG is refused by name", () => {
  const png = encodePng(8, 8, solid(8, 8, [1, 2, 3]));
  // IHDR data starts at 8 (magic) + 8 (len+type); interlace is its 13th byte.
  png[8 + 8 + 12] = 1;
  assert.throws(() => decodePng(png), /interlaced/);
});

test("a 16-bit PNG is refused by name", () => {
  const png = encodePng(8, 8, solid(8, 8, [1, 2, 3]));
  png[8 + 8 + 8] = 16; // bit depth
  assert.throws(() => decodePng(png), /bit depth 16/);
});

console.log(failures ? `\n${failures} FAILED` : "\nall pass");
process.exit(failures ? 1 : 0);
