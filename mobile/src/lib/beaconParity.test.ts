/**
 * The web stub must expose EVERY method its native twin does.
 *
 * beacon.ts and beacon.web.ts are two independent classes that Metro selects
 * between by platform extension — NOT two implementations of a shared
 * interface. A method added to the native side is therefore invisible to the
 * compiler on web and explodes at runtime instead. That is exactly how the
 * browser build shipped "beaconListener.getBootstrapDevices is not a function",
 * thrown inside a setInterval in DeviceContext, leaving the app permanently
 * "Reconnecting (0/5)…" with no usable clue.
 *
 * Reading the SOURCE rather than importing keeps this honest: importing
 * beacon.ts under jest resolves the native module and would prove nothing about
 * what a browser actually loads.
 */
import { readFileSync } from "fs";
import { join } from "path";

const methodsOf = (file: string): string[] => {
  const src = readFileSync(join(__dirname, file), "utf8");
  return [...src.matchAll(/^ {2}([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm)]
    .map((m) => m[1])
    .filter((n) => n !== "constructor")
    .sort();
};

describe("beacon web/native surface parity", () => {
  it("web stub implements every native method", () => {
    const missing = methodsOf("beacon.ts").filter((m) => !methodsOf("beacon.web.ts").includes(m));
    expect(missing).toEqual([]); // each entry here is a runtime crash on web
  });
});
