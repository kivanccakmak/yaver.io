import { mostRecentSuccessfulDeviceId, RECENT_CONNECTION_WINDOW_MS } from "./recentConnection.ts";

let failures = 0;
function check(name: string, condition: boolean) {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}`);
  }
}

const now = 1_000_000_000;

check(
  "uses the actual most recently successful device within 24 hours",
  mostRecentSuccessfulDeviceId([
    { deviceId: "primary", ts: now - 60_000, hadSuccess: true },
    { deviceId: "last", ts: now - 1_000, hadSuccess: true },
  ], now) === "last",
);
check(
  "ignores a connection older than 24 hours",
  mostRecentSuccessfulDeviceId([
    { deviceId: "old", ts: now - RECENT_CONNECTION_WINDOW_MS - 1, hadSuccess: true },
  ], now) === null,
);
check(
  "does not treat an inventory-only cache entry as a successful connection",
  mostRecentSuccessfulDeviceId([
    { deviceId: "never", ts: now - 1_000, hadSuccess: false },
  ], now) === null,
);

console.log(failures === 0 ? "\nAll recentConnection tests passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
