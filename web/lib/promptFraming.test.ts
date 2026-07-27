/**
 * promptFraming.test.ts — `npx tsx lib/promptFraming.test.ts`.
 *
 * Pins the web copy to the SAME values as the Go source, read from disk. Web
 * had no strip at all before this, so there is no legacy behaviour to preserve
 * — only the drift to prevent. mobile/src/lib/promptFramingParity.test.ts does
 * the same for the RN surfaces.
 *
 * Prove it by breaking it: change YAVER_PROMPT_BOUNDARY here or in Go.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  SYSTEM_CONTEXT_END_MARKERS,
  YAVER_PROMPT_BOUNDARY,
  containsYaverFraming,
  sliceAfterFrameBoundary,
} from "./promptFraming";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error("  ✗ " + msg);
  }
}

const goSource = readFileSync(join(__dirname, "../../desktop/agent/result_cleanup.go"), "utf8");

{
  const m = goSource.match(/promptEchoSentinel\s*=\s*"([^"]+)"/);
  ok(m !== null, "promptEchoSentinel not found in result_cleanup.go");
  if (m) ok(m[1] === YAVER_PROMPT_BOUNDARY, `sentinel drift: Go ${JSON.stringify(m[1])} vs web ${JSON.stringify(YAVER_PROMPT_BOUNDARY)}`);
}

{
  const block = goSource.match(/systemContextEndMarkers\s*=\s*\[\]string\{([\s\S]*?)\n\}/);
  ok(block !== null, "systemContextEndMarkers not found in result_cleanup.go");
  if (block) {
    const goMarkers = [...block[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
    const missing = [YAVER_PROMPT_BOUNDARY, ...goMarkers].filter((x) => !SYSTEM_CONTEXT_END_MARKERS.includes(x));
    ok(missing.length === 0, `web marker list is missing Go markers: ${JSON.stringify(missing)}`);
  }
}

{
  const echoed =
    "make it red\n\n[Yaver wrapper capabilities]\n…\n" + YAVER_PROMPT_BOUNDARY +
    "\n[Screen the user is looking at] route: /settings\n" + YAVER_PROMPT_BOUNDARY +
    "\nDone — Header.tsx now uses the accent colour.";
  const got = sliceAfterFrameBoundary(echoed);
  ok(!containsYaverFraming(got), `framing survived the slice: ${JSON.stringify(got)}`);
  ok(got.includes("Done — Header.tsx now uses the accent colour."), `the answer was eaten: ${JSON.stringify(got)}`);
}

{
  const plain = "All three tests pass now.";
  ok(sliceAfterFrameBoundary(plain) === plain, "an unframed answer must pass through untouched");
  ok(!containsYaverFraming(plain), "a real answer must still be speakable");
}

console.log(`\npromptFraming(web): ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
