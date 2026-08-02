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

for (const kind of webKinds) {
  // Swift spells them either as a rawValue string ("project-missing") or, for
  // single-word cases, as a bare case name (`case auth`).
  const asRaw = tvSrc.includes(`"${kind}"`);
  const asCase = new RegExp(`case\\s+${kind.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}\\b`).test(tvSrc);
  ok(asRaw || asCase, `tvOS TargetProbeKind covers "${kind}"`);
}

// ── the wire codes must be identical strings, not merely present ──────────
for (const code of ["project_not_on_this_machine", "relay.device_not_connected"]) {
  ok(webSrc.includes(code) && tvSrc.includes(code), `both surfaces use the exact code "${code}"`);
}

// ── the routing decision itself must match, not just the label ────────────
// A kind that exists on both surfaces but routes differently is worse than a
// missing kind: it looks correct in review and behaves differently in the hand.
ok(
  /kind:\s*\.projectMissing,\s*retry:\s*false,\s*useRunnerFallback:\s*true,\s*showFixWithRunner:\s*false/.test(tvSrc),
  "tvOS routes project-missing identically to web (no retry, runner fallback, never Fix-with-runner)",
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
