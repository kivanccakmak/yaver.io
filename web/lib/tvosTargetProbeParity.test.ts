/**
 * Cross-surface parity: web `runtimeTargetProbeFailure.ts` vs tvOS
 * `FailureSignals.swift`.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * tvOS cannot import `web/lib`. Its classifier is a HAND PORT, and its own
 * comment sets the contract:
 *
 *     "Mirror of web/lib/runtimeTargetProbeFailure.ts — the SAME policy…
 *      if a new relay verdict appears, it gets a code in the agent and a row
 *      here AND there in one change."
 *
 * That contract was broken twice within a day: `auth` (relay-credential
 * refusals) and `project-missing` were both added to the web classifier and
 * neither reached the TV. The consequence is not cosmetic — a missing
 * `project-missing` row means the TV falls through to `other`, which carries
 * `showFixWithRunner: true`, so the TV would spend a real LLM run on a
 * directory listing exactly as the dashboard did on 2026-08-02.
 *
 * A hand-maintained mirror with no test is a guess. This reads both sources and
 * fails when they diverge — the same shape as beaconParity.test.ts, for the
 * same reason: drift between two independent implementations of one policy is
 * invisible to every compiler involved.
 *
 * Run: npx tsx web/lib/tvosTargetProbeParity.test.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webSrc = readFileSync(join(here, "runtimeTargetProbeFailure.ts"), "utf8");
const tvSrc = readFileSync(join(here, "../../tvos/YaverTV/FailureSignals.swift"), "utf8");

let failures = 0;
function ok(cond: unknown, label: string) {
  if (cond) {
    console.log(`ok   ${label}`);
  } else {
    console.error(`FAIL ${label}`);
    failures++;
  }
}

// ── every web failure kind must exist on the TV ───────────────────────────
const webKinds = (webSrc.match(/export type RuntimeTargetProbeFailureKind =([\s\S]*?);/)?.[1] || "")
  .split("|")
  .map((s) => s.replace(/["\s|]/g, ""))
  .filter(Boolean);

ok(webKinds.length >= 5, `web declares its kinds (${webKinds.join(", ")})`);

// Scoped to the enum body and compared as WHOLE raw values. Searching the whole
// file for `"auth"` passed while tvOS actually spelled it `"relay-auth"` — the
// substring made the guard agree with a drift it existed to catch (2026-08-02).
const tvKindEnum = (() => {
  const start = tvSrc.indexOf("enum TargetProbeKind");
  if (start < 0) return "";
  const end = tvSrc.indexOf("}", start);
  return end > start ? tvSrc.slice(start, end) : "";
})();
ok(tvKindEnum.length > 0, "tvOS declares a TargetProbeKind enum");
const tvRawValues = new Set(
  Array.from(tvKindEnum.matchAll(/case\s+(\w+)(?:\s*=\s*"([^"]+)")?/g))
    // A Swift case with no explicit rawValue takes its own name (`case other`).
    .map((m) => m[2] || m[1]),
);
for (const kind of webKinds) {
  ok(tvRawValues.has(kind), `tvOS TargetProbeKind covers "${kind}" as a whole value`);
}

// ── the wire codes must be identical strings, not merely present ──────────
for (const code of ["project_not_on_this_machine", "relay.device_not_connected"]) {
  ok(webSrc.includes(code) && tvSrc.includes(code), `both surfaces use the exact code "${code}"`);
}

// ── the relay-credential matcher must not have drifted ────────────────────
// Mobile already shipped THREE different relay-auth matchers, none a superset
// of the others. Pin the shared phrases so a fourth cannot appear quietly.
for (const phrase of ["relay_password_missing", "relay_password_invalid", "relay_password_rate_limited"]) {
  ok(webSrc.includes(phrase) && tvSrc.includes(phrase), `relay-credential matcher shares "${phrase}"`);
}

// ── the routing decision itself must match, not just the label ────────────
// A kind that exists on both surfaces but routes differently is worse than a
// missing kind: it looks correct in review and behaves differently in the hand.
ok(
  /kind:\s*\.projectMissing,\s*retry:\s*false,\s*useRunnerFallback:\s*true,\s*showFixWithRunner:\s*false/.test(tvSrc),
  "tvOS routes project-missing identically to web (no retry, runner fallback, never Fix-with-runner)",
);
ok(
  // Swift case name is `relayAuth`; its rawValue "auth" is what must match web.
  /kind:\s*\.relayAuth,\s*retry:\s*true,\s*useRunnerFallback:\s*false,\s*showFixWithRunner:\s*false/.test(tvSrc),
  "tvOS routes a relay-credential refusal identically to web",
);

// ── the fail-open default must survive on both ────────────────────────────
// An unrecognised failure SHOULD still offer a coding agent: that is the one
// case where escalation is the right answer, and gating it would be a false red.
ok(
  /kind:\s*\.other,\s*retry:\s*false,\s*useRunnerFallback:\s*false,\s*showFixWithRunner:\s*true/.test(tvSrc),
  "tvOS still fails OPEN to Fix-with-runner for unrecognised failures",
);
ok(
  /kind:\s*"other",[\s\S]{0,120}showFixWithRunner:\s*true/.test(webSrc),
  "web still fails OPEN to Fix-with-runner for unrecognised failures",
);

if (failures) {
  console.error(`\ntvosTargetProbeParity: ${failures} FAILED — the TV and the dashboard disagree about how to route a failure`);
  process.exitCode = 1;
} else {
  console.log("\ntvosTargetProbeParity: ALL PASS");
}
