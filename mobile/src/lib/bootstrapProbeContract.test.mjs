import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../context/DeviceContext.tsx", import.meta.url), "utf8");
const pickerSource = readFileSync(new URL("../components/RemoteBoxPickerModal.tsx", import.meta.url), "utf8");

test("bootstrap recovery does not probe stale offline inventory", () => {
  assert.match(source, /const recoveryDevices = devices\.filter\([\s\S]*?d\.needsAuth === true/);
  assert.doesNotMatch(source, /\(!d\.online \|\| d\.needsAuth === true\)/);
});

test("direct anonymous info probe requires a named auth-recovery state", () => {
  assert.match(
    source,
    /!activeDevice\?\.host \|\| activeDevice\.needsAuth !== true\) return;/,
  );
});

test("unconfigured discovery probes only online auth-ready machines", () => {
  assert.match(
    source,
    /const discoveryCandidates = candidates\.filter\(\(device\) =>[\s\S]*?device\.online &&[\s\S]*?device\.needsAuth !== true/,
  );
  assert.match(source, /discoveryCandidates\.map\(async \(d\) =>/);
  assert.doesNotMatch(source, /candidates\.map\(async \(d\) =>/);
});

test("machine picker batches runner probes and skips offline inventory", () => {
  const start = pickerSource.indexOf("// Runner inventory is useful only");
  const end = pickerSource.indexOf("const pickedDevice =", start);
  assert.ok(start >= 0 && end > start);
  const effect = pickerSource.slice(start, end);
  assert.match(effect, /const pending = eligibleDevices\.filter\([\s\S]*?device\.online \|\| connectedSet\.has\(device\.id\)/);
  assert.match(effect, /const rows = await Promise\.all\(pending\.map/);
  assert.match(effect, /for \(const \[deviceId, status\] of rows\) next\[deviceId\] = status/);
  assert.doesNotMatch(effect, /for \(const device of eligibleDevices\)/);
});
