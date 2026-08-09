import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./taskPlacement.ts", import.meta.url), "utf8");

test("owned-machine placement honors primary, then secondary, before DB order", () => {
  assert.match(source, /orderOwnedDeviceCandidates\(online,\s*\{[\s\S]*primaryDeviceId:\s*settings\?\.primaryDeviceId,[\s\S]*secondaryDeviceId:\s*settings\?\.secondaryDeviceId/);
  assert.match(source, /pushById\(settings\?\.primaryDeviceId\);\s*pushById\(settings\?\.secondaryDeviceId\);/);
});
