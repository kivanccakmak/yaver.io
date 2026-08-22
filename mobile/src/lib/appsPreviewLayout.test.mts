// Source-level guard for the compact Projects/Preview UX. These assertions
// deliberately target the shipped apps.tsx surface: the regressions were
// native layout composition defects, not helper-function mistakes.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = readFileSync(join(mobileRoot, "app/(tabs)/apps.tsx"), "utf8");

assert.doesNotMatch(src, /<LaneStartupStatus[\s\S]{0,400}lines=\{webPreviewLogs\}/,
  "elapsed status must not repeat loose log lines above the log box");
assert.match(src, /webPreviewLogs\.length > 0 && !webRuntimeLogOpen/,
  "the inline log box must hide while the Preview logs panel is open");
assert.doesNotMatch(src, /\(coming soon\)/,
  "supported Hermes reload must not be described as coming soon");
assert.match(src, /openBtn:\s*\{[^\n]*flex:\s*0/,
  "Open in Yaver must remain a compact action rather than fill the card");
assert.match(src, /filterRow:\s*\{\s*height:\s*38/,
  "the chip ScrollView must be taller than its 34pt selected chips");

console.log("Projects preview layout contract ok");
