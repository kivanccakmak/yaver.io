// incidentSignals.test.ts — `npx tsx lib/incidentSignals.test.ts` (from web/)
//
// The assertions are mostly about which incidents may offer a Retry, and which
// deserve a coding agent. Those are the two decisions prose cannot carry, and
// getting either wrong sends the user somewhere useless: a Retry over a missing
// compiler, or an LLM run over a dev server that simply is not started.

import { readFileSync } from "fs";
import { join } from "path";
import {
  BUILD_HERMES_FAILED,
  BUILD_NATIVE_FAILED,
  RELOAD_DEV_SERVER_UNAVAILABLE,
  RELOAD_NATIVE_REBUILD_REQUIRED,
  RELOAD_PREVIEW_WORKER_OFFLINE,
  classifyIncident,
  incidentIsAIFixable,
  incidentSuppressesRetry,
} from "./incidentSignals";

let failures = 0;
function eq(got: unknown, want: unknown, label: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.error(`FAIL ${label}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
    failures++;
  } else console.log(`ok ${label}`);
}

// Unknown / absent codes fall through to the agent's prose — an older agent
// must not lose its message.
eq(classifyIncident(undefined), null, "no code falls back to prose");
eq(classifyIncident("something.new"), null, "an unknown code falls back to prose");

// A missing compiler does not appear because you pressed a button again.
eq(incidentSuppressesRetry(BUILD_HERMES_FAILED), true, "no Retry over a missing Hermes compiler");
eq(incidentIsAIFixable(BUILD_HERMES_FAILED), false, "a coding agent cannot install a toolchain");
eq(classifyIncident(BUILD_HERMES_FAILED)?.fault, "environment", "missing hermesc is the environment");

// The user's own project failing to build IS the coding-agent case.
eq(classifyIncident(BUILD_NATIVE_FAILED)?.fault, "project", "a failed native build is the project");
eq(incidentIsAIFixable(BUILD_NATIVE_FAILED), true, "a failed project build is what a coding agent is for");
eq(incidentSuppressesRetry(BUILD_NATIVE_FAILED), false === false, "a failed build should not simply be retried");

// No dev server is not a fault to retry — it is a thing to start.
eq(classifyIncident(RELOAD_DEV_SERVER_UNAVAILABLE)?.fault, "environment", "no dev server is environmental");
eq(incidentSuppressesRetry(RELOAD_DEV_SERVER_UNAVAILABLE), true, "no Retry when there is nothing to reload");
eq(incidentIsAIFixable(RELOAD_DEV_SERVER_UNAVAILABLE), false, "do not spend an LLM run on an unstarted dev server");

// A hot reload can never carry a native change.
eq(incidentSuppressesRetry(RELOAD_NATIVE_REBUILD_REQUIRED), true, "no Retry when a native rebuild is required");

// The worker reconnects by itself, so a retry is honest.
eq(classifyIncident(RELOAD_PREVIEW_WORKER_OFFLINE)?.fault, "transient", "an offline worker is transient");
eq(incidentSuppressesRetry(RELOAD_PREVIEW_WORKER_OFFLINE), false, "Retry is allowed for a worker that reconnects");

// Exactly ONE of the five should be AI-fixable. If that ever becomes two, the
// escalation rule ("only when there is no deterministic fixer") has slipped.
const aiFixable = [
  RELOAD_DEV_SERVER_UNAVAILABLE, RELOAD_NATIVE_REBUILD_REQUIRED, RELOAD_PREVIEW_WORKER_OFFLINE,
  BUILD_HERMES_FAILED, BUILD_NATIVE_FAILED,
].filter(incidentIsAIFixable);
eq(aiFixable, [BUILD_NATIVE_FAILED], "only the project's own build failure escalates to a coding agent");

// PARITY — Metro/webpack pick per platform, so drift is invisible to tsc.
const strip = (s: string) => s.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n").trim();
const repoRoot = join(__dirname, "..", "..");
eq(
  strip(readFileSync(join(repoRoot, "web/lib/incidentSignals.ts"), "utf8")) ===
    strip(readFileSync(join(repoRoot, "mobile/src/lib/incidentSignals.ts"), "utf8")),
  true,
  "web and mobile incident classifiers are byte-identical below the header",
);

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall incident-signal checks passed");
