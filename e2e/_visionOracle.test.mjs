// _visionOracle.test.mjs — `node e2e/_visionOracle.test.mjs`
//
// THE ORACLE MAY DESCRIBE WHAT IT SEES. IT MAY NOT PRESCRIBE A REMEDY.
//
// It reads TEXT off a captured frame. That tells it what is on screen and
// nothing else — not which binaries exist on the box, not which one was chosen,
// not why a process failed to start. On 2026-08-04 one entry asserted "this is
// the confined-snap Chrome failure; the box needs an unconfined build" about a
// machine whose /usr/bin/google-chrome launches headless perfectly, while the
// agent had logged no browser error at all. A confidently wrong remedy is worse
// than none: it sends someone to reinstall a working browser and hides the real
// cause for as long as they believe it.
//
// Remedies belong to the component that can MEASURE — the agent, which probes
// the binaries and emits browser_window.* with a per-cause fix.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, "_visionOracle.mjs"), "utf8");

// Strip comments: the file DISCUSSES the removed remedy on purpose, and a guard
// that cannot tell code from the commentary explaining its own removal fires on
// the fix instead of the bug (learned twice in this session).
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("//"))
  .join("\n");

// Phrases that PRESCRIBE infrastructure action. An oracle sentence containing one
// is claiming knowledge it cannot have from pixels.
const PRESCRIPTIONS = [
  /needs an unconfined build/i,
  /\breinstall\b/i,
  /\bapt(-get)? install\b/i,
  /\bsnap remove\b/i,
  /the box needs\b/i,
  /you (must|should) install/i,
];

let failures = 0;
for (const rx of PRESCRIPTIONS) {
  const m = code.match(rx);
  if (m) {
    console.error(
      `FAIL an oracle entry prescribes a remedy (${JSON.stringify(m[0])}). ` +
      `The oracle reads pixels; it cannot know which binaries exist or why one failed. ` +
      `Describe what is ON SCREEN and let the agent's typed gap carry the fix.`,
    );
    failures++;
  }
}

// And it must still SAY something for the launch-error case — silence was the
// original defect this file exists to remove.
if (!/browser launch error/i.test(code)) {
  console.error("FAIL the launch-error entry lost its observation; a silent frame is the verdict CLAUDE.md calls a real failure");
  failures++;
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("ok — the vision oracle describes what it sees and prescribes nothing");
