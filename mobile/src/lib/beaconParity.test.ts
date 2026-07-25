/**
 * beaconParity.test.ts — `npx tsx src/lib/beaconParity.test.ts`.
 * No RN, no jest — reads the two SOURCES and compares their method surfaces.
 *
 * beacon.ts and beacon.web.ts are two independent classes chosen by Metro's
 * platform extension, NOT two implementations of one interface. A method added
 * to the native twin is invisible to tsc on web and throws at RUNTIME, in a
 * timer, on the least-tested surface. That shipped
 * "beaconListener.getBootstrapDevices is not a function" — a permanent
 * "Reconnecting (0/5)…" in the browser build.
 *
 * Reading source rather than importing is deliberate: importing beacon.ts here
 * resolves the NATIVE module and would prove nothing about what a browser loads.
 */
import { readFileSync } from "fs";
import { join } from "path";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error("  ✗ " + msg);
  }
}

const methodsOf = (file: string): string[] =>
  [...readFileSync(join(__dirname, file), "utf8").matchAll(/^ {2}([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm)]
    .map((m) => m[1])
    .filter((n) => n !== "constructor")
    .sort();

{
  const missing = methodsOf("beacon.ts").filter((m) => !methodsOf("beacon.web.ts").includes(m));
  ok(missing.length === 0, `web stub is missing native methods: ${missing.join(", ")}`);
}

console.log(`\nbeaconParity: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
