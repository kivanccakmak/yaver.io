import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = readFileSync(join(mobileRoot, "app/(tabs)/more.tsx"), "utf8");
const leanGuard = source.indexOf("{!LEAN_MORE_SURFACE ? (");
const usageEntry = source.indexOf('accessibilityLabel="Develop Yaver with Yaver"');
const settingsEntry = source.indexOf('accessibilityLabel="Open Dogfood settings"');

assert.ok(usageEntry > 0 && usageEntry < leanGuard,
  "the lean More surface must expose Dogfood usage outside the unreachable legacy tool block");
assert.ok(settingsEntry > usageEntry && settingsEntry < leanGuard,
  "the lean More surface must expose Dogfood settings as a separate destination");
const leanSource = source.slice(0, leanGuard);
assert.match(leanSource, /pathname: "\/\(tabs\)\/dogfood" as any, params: \{ view: "usage" \}/,
  "the Dogfood usage entry must open the usage surface");
assert.match(leanSource, /pathname: "\/\(tabs\)\/dogfood" as any, params: \{ view: "settings" \}/,
  "the Dogfood settings entry must open the settings surface");
console.log("More Dogfood contract ok");
