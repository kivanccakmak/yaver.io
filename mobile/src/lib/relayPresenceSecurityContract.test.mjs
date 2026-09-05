import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const context = readFileSync(new URL("../context/DeviceContext.tsx", import.meta.url), "utf8");

test("tenant mobile clients never call the relay operator presence endpoint", () => {
  assert.doesNotMatch(
    context,
    /relay\.httpUrl}\/presence|applyRelayPresence\(/,
    "DeviceContext must use real agent probes and peer bus events, not admin-only relay inventory",
  );
  assert.match(context, /subscribeBusEvents\(/, "the authenticated live-presence consumer was removed");
  assert.match(context, /probeMobileDeviceStatus\(/, "the real reachability probe was removed");
});
