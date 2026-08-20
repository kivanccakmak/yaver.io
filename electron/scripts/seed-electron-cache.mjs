#!/usr/bin/env node
/* Pre-seed the @electron/get cache so electron-builder's flaky CDN download
 * never aborts the MAS universal build. Retries with backoff; a fresh copy of
 * the cache regenerates on demand. Usage: node seed-electron-cache.mjs */
import { downloadArtifact } from "@electron/get";

const version = "43.4.0";
const archs = ["x64", "arm64"];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

for (const arch of archs) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const p = await downloadArtifact({
        version,
        platform: "darwin",
        arch,
        artifactName: "electron",
      });
      console.log(`[seed] electron ${arch} ready: ${p}`);
      break;
    } catch (err) {
      if (attempt >= 8) {
        console.error(`[seed] electron ${arch} FAILED after 8 attempts: ${err.message}`);
        process.exit(1);
      }
      const backoff = 4000 * attempt;
      console.warn(`[seed] electron ${arch} attempt ${attempt} failed (${err.message}); retrying in ${backoff}ms`);
      await sleep(backoff);
    }
  }
}
console.log("[seed] both archs cached");
