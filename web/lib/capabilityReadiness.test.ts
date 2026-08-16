// capabilityReadiness.test.ts — `npx tsx lib/capabilityReadiness.test.ts` (from web/)
//
// The point of classifying by code is that a PERMANENT fact and a MOMENTARY
// outage stop looking alike. So the assertions are mostly about which states may
// offer a Retry — that is the user-visible difference, and offering one over a
// settled fact is an action that can never succeed.

import { readFileSync } from "fs";
import { join } from "path";
import {
  CONNECTIVITY_NO_VIABLE_TRANSPORT,
  DEPLOY_PLAY_ANDROID_SDK_MISSING,
  DEPLOY_TESTFLIGHT_XCODE_MISSING,
  classifyReadiness,
  readinessSuppressesRetry,
} from "./capabilityReadiness";

let failures = 0;
function eq(got: unknown, want: unknown, label: string) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.error(`FAIL ${label}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
    failures++;
  } else console.log(`ok ${label}`);
}

// A healthy target explains nothing — rendering a verdict for it is clutter.
eq(classifyReadiness({ enabled: true, reasonCode: DEPLOY_TESTFLIGHT_XCODE_MISSING }), null, "enabled target yields no verdict");
eq(classifyReadiness(null), null, "null target yields no verdict");
eq(classifyReadiness({ enabled: false }), null, "no code at all falls back to the agent's prose");

// Xcode on Linux can never become true.
eq(classifyReadiness({ enabled: false, reasonCode: DEPLOY_TESTFLIGHT_XCODE_MISSING })?.kind, "platform-constraint", "missing Xcode is a platform constraint");
eq(readinessSuppressesRetry({ enabled: false, reasonCode: DEPLOY_TESTFLIGHT_XCODE_MISSING }), true, "no Retry over a settled platform fact");

// The Android SDK is installable, so it is a missing thing, not a limit.
eq(classifyReadiness({ enabled: false, reasonCode: DEPLOY_PLAY_ANDROID_SDK_MISSING })?.kind, "fixable", "missing Android SDK is fixable");
eq(readinessSuppressesRetry({ enabled: false, reasonCode: DEPLOY_PLAY_ANDROID_SDK_MISSING }), true, "a fixable gap wants its fix, not a Retry");

// Transport genuinely changes on its own — a retry IS honest here.
eq(classifyReadiness({ enabled: false, reasonCode: CONNECTIVITY_NO_VIABLE_TRANSPORT })?.kind, "transient", "no transport is transient");
eq(readinessSuppressesRetry({ enabled: false, reasonCode: CONNECTIVITY_NO_VIABLE_TRANSPORT }), false, "Retry is allowed for a momentary outage");

// The dynamic families the agent composes per target.
eq(classifyReadiness({ enabled: false, reasonCode: "capability.testflight.doctor_failed" })?.kind, "fixable", "a per-target doctor failure is fixable");
eq(classifyReadiness({ enabled: false, reasonCode: "capability.mobile-hermes.not_ready" })?.kind, "fixable", "hermes-not-ready is fixable");

// A NEWER agent's code must not vanish: the target is still unavailable.
const unknown = classifyReadiness({ enabled: false, reasonCode: "capability.something.brand_new" });
eq(unknown?.kind, "unknown", "an unrecognised code still produces a verdict");
eq(unknown?.retryable, false, "an unrecognised code must not claim a retry would help");

// PARITY. Metro/webpack pick per platform, so drift is invisible to tsc.
const strip = (s: string) => s.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n").trim();
const repoRoot = join(__dirname, "..", "..");
eq(
  strip(readFileSync(join(repoRoot, "web/lib/capabilityReadiness.ts"), "utf8")) ===
    strip(readFileSync(join(repoRoot, "mobile/src/lib/capabilityReadiness.ts"), "utf8")),
  true,
  "web and mobile classifiers are byte-identical below the header",
);

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall capability-readiness checks passed");
