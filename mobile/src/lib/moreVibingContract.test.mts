import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = readFileSync(join(mobileRoot, "app/(tabs)/more.tsx"), "utf8");
const leanGuard = source.indexOf("{!LEAN_MORE_SURFACE ? (");
const entry = source.indexOf('accessibilityLabel="Open Vibing"');

assert.ok(entry > 0 && entry < leanGuard,
  "the lean More surface must expose Vibing outside the unreachable legacy tool block");
assert.match(source.slice(0, leanGuard), /router\.navigate\("\/vibing" as any\)/,
  "the lean entry must open the project-preview Vibing surface, not the voice-only /vibe route");
console.log("More Vibing contract ok");
