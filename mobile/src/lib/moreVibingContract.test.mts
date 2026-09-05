import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = readFileSync(join(mobileRoot, "app/(tabs)/more.tsx"), "utf8");
const leanGuard = source.indexOf("{!LEAN_MORE_SURFACE ? (");
const dogfoodEntry = source.indexOf('accessibilityLabel="Develop Yaver with Yaver"');

assert.ok(dogfoodEntry > 0 && dogfoodEntry < leanGuard,
  "the lean More surface must expose Dogfood outside the unreachable legacy tool block");
const leanSource = source.slice(0, leanGuard);
assert.match(leanSource, /router\.navigate\("\/\(tabs\)\/dogfood" as any\)/,
  "the single Dogfood entry must open the native Dogfood surface");
assert.doesNotMatch(leanSource, /Open Dogfood settings/,
  "Dogfood settings must not compete with the single primary Dogfood entry");
console.log("More Dogfood contract ok");
