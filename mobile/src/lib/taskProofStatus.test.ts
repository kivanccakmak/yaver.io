/**
 * taskProofStatus.test.ts — `npx tsx src/lib/taskProofStatus.test.ts`.
 * Same dependency-free harness as connectGuard.test.ts.
 *
 * Pins B12 (task-proof audit 2026-07): a failed/stale/unknown capture status
 * must render a NAMED cause — a non-empty sentence — never an empty string
 * and never nothing. Includes the negative control: fuzz every status shape
 * we can produce and assert no failure-shaped input ever maps to "".
 */
import {
  formatProofDuration,
  proofFailureLine,
  proofIsInFlight,
  proofIsReady,
  proofLaneLabel,
} from "./taskProofStatus";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}`);
  }
}

console.log("proofFailureLine (B12: named cause, never empty)");

// Non-failures → null (the card shows progress or the play hero instead).
check("ready is not a failure", proofFailureLine("ready") === null);
check("capturing is not a failure", proofFailureLine("capturing") === null);
check("queued is not a failure", proofFailureLine("queued") === null);
check("recording is not a failure", proofFailureLine("recording") === null);
check("absent status is not a failure", proofFailureLine(undefined) === null && proofFailureLine(null) === null && proofFailureLine("") === null);

// Failures → a full named sentence.
const failedNamed = proofFailureLine("failed", "recorder timed out");
check("failed carries the agent's reason verbatim",
  !!failedNamed && failedNamed.includes("recorder timed out") && failedNamed.startsWith("Demo not captured"));
const failedBare = proofFailureLine("failed");
check("failed WITHOUT a reason still names a cause (never empty)",
  !!failedBare && failedBare.length > 10);
const stale = proofFailureLine("stale");
check("stale names a cause", !!stale && stale.startsWith("Demo out of date"));

// THE B12 regression primitive: an unknown status from a newer agent must
// still produce a named line — silence here is the shipped bug.
const unknown = proofFailureLine("exploded");
check("unknown status maps to a named string mentioning the status",
  !!unknown && unknown.includes("exploded"));

// Negative control (prove the guard by breaking its precondition): every
// failure-shaped input across the fuzz set must yield a non-empty string.
// If someone edits proofFailureLine to return "" for any branch, this fails.
const fuzz = ["failed", "stale", "wat", "FAILED?", "error", "timeout", "💥", "null"];
check("fuzz: no failure-shaped status ever maps to an empty string",
  fuzz.every((s) => {
    const line = proofFailureLine(s, undefined);
    return typeof line === "string" && line.trim().length > 0;
  }));
check("fuzz with reasons: reason is carried, result still non-empty",
  fuzz.every((s) => {
    const line = proofFailureLine(s, "because reasons");
    return typeof line === "string" && line.trim().length > 0 && line.includes("because reasons");
  }));

console.log("in-flight / ready classification");
check("capturing|queued|recording are in flight",
  proofIsInFlight("capturing") && proofIsInFlight("queued") && proofIsInFlight("recording"));
check("ready/failed/absent are not in flight",
  !proofIsInFlight("ready") && !proofIsInFlight("failed") && !proofIsInFlight(undefined));
check("only ready is ready", proofIsReady("ready") && !proofIsReady("capturing") && !proofIsReady("failed"));

console.log("proofLaneLabel");
check("browser lane", proofLaneLabel("browser") === "browser demo");
check("sim-ios lane", proofLaneLabel("sim-ios") === "iOS simulator demo");
check("sim-android lane", proofLaneLabel("sim-android") === "Android emulator demo");
check("phone lane", proofLaneLabel("phone") === "phone demo");
check("unknown lane still readable", proofLaneLabel("hologram") === "hologram demo");
check("absent lane → null (caption omitted, not blank)", proofLaneLabel(undefined) === null && proofLaneLabel("") === null);

console.log("formatProofDuration");
check("0 → 0:00", formatProofDuration(0) === "0:00");
check("7 → 0:07", formatProofDuration(7) === "0:07");
check("75 → 1:15", formatProofDuration(75) === "1:15");
check("negative/NaN clamp to 0:00", formatProofDuration(-3) === "0:00" && formatProofDuration(Number.NaN) === "0:00");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
if (failures > 0) process.exit(1);
