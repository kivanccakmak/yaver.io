/**
 * devEventLine.test.ts — `npx tsx lib/devEventLine.test.ts` from web/.
 * Same tiny assert harness as wakeProgress.test.ts / agentStatus.test.ts.
 *
 * The bug this pins: the runtime console rendered "1575% streaming" because
 * it multiplied the agent's already-0..100 `pct` by 100. The agent contract
 * (devserver.go Pct field) is 0..100; the formatter must not rescale it and
 * must clamp anything out of range.
 */
import { formatDevProgressLine } from "./devEventLine";

let failures = 0;
function assertEq(actual: string, expected: string, label: string) {
  if (actual !== expected) {
    failures++;
    console.error(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// The regression: 15.75 (0..100 scale) must NOT become 1575%.
assertEq(formatDevProgressLine("web", 15.75, "streaming"), "web: 16% streaming", "no double-scaling");
assertEq(formatDevProgressLine("web", 100, "done"), "web: 100% done", "full");
assertEq(formatDevProgressLine("web", 0, "starting"), "web: 0% starting", "zero");
// Out-of-range and junk inputs clamp instead of leaking bogus numbers.
assertEq(formatDevProgressLine("web", 1575, "streaming"), "web: 100% streaming", "clamp high");
assertEq(formatDevProgressLine("web", -3, "streaming"), "web: 0% streaming", "clamp low");
assertEq(formatDevProgressLine("web", undefined, "streaming"), "web: 0% streaming", "missing pct");
assertEq(formatDevProgressLine("web", Number.NaN, "streaming"), "web: 0% streaming", "NaN pct");
// Missing phase drops the trailing space.
assertEq(formatDevProgressLine("web", 42, undefined), "web: 42%", "no phase");

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("devEventLine.test.ts: all assertions passed");
