/**
 * pendingDeviceCode.test.ts — `npx tsx src/lib/pendingDeviceCode.test.ts`.
 * No RN, no jest — pure harness for the stashed-device-code rules.
 */
import {
  PENDING_DEVICE_CODE_TTL_MS,
  isPendingDeviceCodeShape,
  parsePendingDeviceCode,
  serializePendingDeviceCode,
} from "./pendingDeviceCode";

let failures = 0;

function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}`);
  }
}

const NOW = 1_784_961_070_844;

console.log("isPendingDeviceCodeShape");
check("accepts ABCD-1234", isPendingDeviceCodeShape("DUBZ-2698"));
check("accepts lowercase", isPendingDeviceCodeShape("dubz-2698"));
check("rejects unhyphenated", !isPendingDeviceCodeShape("DUBZ2698"));
check("rejects short", !isPendingDeviceCodeShape("DUB-269"));
check("rejects empty", !isPendingDeviceCodeShape(""));

console.log("parsePendingDeviceCode — round trip");
const fresh = parsePendingDeviceCode(serializePendingDeviceCode("DUBZ-2698", NOW), NOW + 5_000);
check("round-trips the code", fresh?.code === "DUBZ-2698");
check("reports age", fresh?.ageMs === 5_000);
check("fresh is not stale", fresh?.stale === false);

console.log("parsePendingDeviceCode — TTL");
const justInside = parsePendingDeviceCode(
  serializePendingDeviceCode("DUBZ-2698", NOW),
  NOW + PENDING_DEVICE_CODE_TTL_MS,
);
check("at exactly the TTL is still usable", justInside?.stale === false);
const past = parsePendingDeviceCode(
  serializePendingDeviceCode("DUBZ-2698", NOW),
  NOW + PENDING_DEVICE_CODE_TTL_MS + 1,
);
check("one ms past the TTL is stale", past?.stale === true);
check("stale still exposes the code (for logging)", past?.code === "DUBZ-2698");

console.log("parsePendingDeviceCode — junk in, null out");
check("null", parsePendingDeviceCode(null, NOW) === null);
check("empty string", parsePendingDeviceCode("", NOW) === null);
check("malformed json", parsePendingDeviceCode("{nope", NOW) === null);
check("json without a code", parsePendingDeviceCode('{"at":1}', NOW) === null);
check(
  "json with a non-code code",
  parsePendingDeviceCode('{"code":"hello","at":1}', NOW) === null,
);

console.log("parsePendingDeviceCode — legacy bare string (pre-1.18.161 builds)");
const legacy = parsePendingDeviceCode("DUBZ-2698", NOW);
check("legacy value is read", legacy?.code === "DUBZ-2698");
check("legacy is treated as fresh, not dropped", legacy?.stale === false);

console.log("parsePendingDeviceCode — clock weirdness");
const backwards = parsePendingDeviceCode(
  serializePendingDeviceCode("DUBZ-2698", NOW),
  NOW - 60_000,
);
check("a clock that moved backwards is not stale", backwards?.stale === false);
check("negative age clamps to 0", backwards?.ageMs === 0);
const noTimestamp = parsePendingDeviceCode('{"code":"DUBZ-2698"}', NOW);
check("missing timestamp is treated as fresh", noTimestamp?.stale === false);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
