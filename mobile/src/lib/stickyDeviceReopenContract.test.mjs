import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../context/DeviceContext.tsx", import.meta.url), "utf8");

test("explicit device picks persist across a cold reopen", () => {
  assert.match(source, /function lastSelectedDeviceKey\(userId\?: string\): string/);
  assert.match(source, /AsyncStorage\.getItem\(lastSelectedDeviceKey\(user\.id\)\)/);
  assert.match(source, /userSelectedDeviceIdRef\.current = next \|\| null/);
  assert.match(source, /AsyncStorage\.setItem\(lastSelectedDeviceKey\(user\.id\), device\.id\)/);
  assert.match(source, /!settingsReady \|\| !codingModeReady \|\| !stickyDeviceReady \|\| !allowsRemoteAutoConnect\(codingMode\)/);
});
