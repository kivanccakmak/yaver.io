/**
 * ALL-SURFACE failure-signal parity.
 *
 * Yaver classifies runner failures on SEVEN surfaces: web (TS), the Go agent,
 * mobile/RN, tvOS (Swift), watchOS (Swift), Wear OS (Kotlin) and visionOS
 * (Swift). Native surfaces cannot import web/lib, so six of those are
 * independent copies of one policy.
 *
 * This repo has already paid for that shape twice:
 *   • three relay-auth matchers drifted apart, none a superset of the others;
 *   • on 2026-08-02 EVERY matcher was missing Anthropic's actual OAuth-expiry
 *     wording ("OAuth token has expired…"), so the commonest runner failure
 *     there is produced no route on any surface at all.
 *
 * So the strings live once in docs/architecture/FAILURE_SIGNALS.json and this
 * test asserts every surface embeds them. A cause one surface can name and
 * another cannot is a user on the wrong device staring at a raw provider dump.
 *
 * Run: npx tsx web/lib/failureSignalParity.test.ts
 */
import { readFileSync, existsSync} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");

const canonical = JSON.parse(readFileSync(join(repo, "docs/architecture/FAILURE_SIGNALS.json"), "utf8"));

/** Every surface that classifies runner failures, and where its copy lives. */
const SURFACES: Array<{ name: string; path: string }> = [
  { name: "web", path: "web/lib/runnerFailure.ts" },
  { name: "agent (Go)", path: "desktop/agent/runner_auth.go" },
  { name: "mobile (RN)", path: "mobile/src/components/ErrorMessage.tsx" },
  { name: "tvOS", path: "tvos/YaverTV/FailureSignals.swift" },
  { name: "watchOS", path: "watch/YaverWatch/FailureSignals.swift" },
  { name: "Wear OS", path: "wear/app/src/main/kotlin/io/yaver/wear/FailureSignals.kt" },
  // visionOS deliberately has NO copy: project.yml compiles the tvOS file
  // directly (`path: ../tvos/YaverTV/FailureSignals.swift`). It briefly had one
  // anyway, and the duplicate filename broke the visionOS archive outright —
  // two `enum FailureSignals` in one module (2026-08-03). Pointing this guard
  // at a per-surface copy would REQUIRE the very drift the sharing prevents,
  // so visionOS is asserted below by SHARING, not by content.
  { name: "visionOS", path: "tvos/YaverTV/FailureSignals.swift" },
];

const sources = new Map<string, string>();
for (const s of SURFACES) {
  sources.set(s.name, readFileSync(join(repo, s.path), "utf8").toLowerCase());
}

let failures = 0;
const ok = (cond: unknown, label: string) => {
  if (cond) console.log(`ok   ${label}`);
  else { console.error(`FAIL ${label}`); failures++; }
};

/**
 * Signals every surface must be able to name.
 *
 * Scoped deliberately: the Go agent and mobile classify a SUBSET by design (the
 * agent decides runner auth-invalidation, mobile drives a retry button), so
 * requiring literal coverage of every string there would be a false red. What
 * IS required of all seven is the set of CAUSES below — the ones where getting
 * the route wrong sends a user somewhere that cannot help them.
 */
const MUST_BE_EVERYWHERE = [
  "credit balance is too low",
  "rate_limit_error",
  "oauth token has expired",
  "model is not supported",
];

for (const needle of MUST_BE_EVERYWHERE) {
  for (const s of SURFACES) {
    ok(sources.get(s.name)!.includes(needle), `${s.name} names "${needle}"`);
  }
}

// The full canonical table must be covered by the surfaces that own the
// complete policy (web + the four native classifiers). Go and mobile are
// intentionally partial, as described above.
const FULL_POLICY_SURFACES = ["web", "tvOS", "watchOS", "Wear OS", "visionOS"];
for (const [kind, def] of Object.entries<any>(canonical.kinds)) {
  for (const signal of def.signals as string[]) {
    for (const name of FULL_POLICY_SURFACES) {
      const src = sources.get(name)!;
      // `unauthorized` appears inside longer words on some surfaces; a plain
      // substring check is what the classifiers themselves do, so match that.
      ok(src.includes(signal.toLowerCase()), `${name} covers ${kind} signal "${signal}"`);
    }
  }
}

// ── THE LAW: non-credential failures must not route to sign-in ─────────────
// Each native classifier states this explicitly, so a future edit that widens
// routesToSignIn has to delete an assertion rather than slip through.
for (const name of ["tvOS", "watchOS", "visionOS"]) {
  const src = sources.get(name)!;
  ok(/routestosignin/.test(src), `${name} exposes a routesToSignIn decision`);
  ok(/kind == \.auth \|\| kind == \.authrevoked/.test(src),
    `${name} routes ONLY auth and auth-revoked to sign-in`);
}
{
  const src = sources.get("Wear OS")!;
  ok(/routestosignin/.test(src), "Wear OS exposes a routesToSignIn decision");
  ok(/kind == runnerfailurekind\.auth \|\| kind == runnerfailurekind\.auth_revoked/.test(src),
    "Wear OS routes ONLY auth and auth-revoked to sign-in");
}

// ── NO FALSE REDS: the remedies must not send people to OAuth ─────────────
for (const name of ["tvOS", "watchOS", "Wear OS", "visionOS"]) {
  const src = sources.get(name)!;
  ok(/signing in will not help|do not sign in again/.test(src),
    `${name} says plainly that signing in does NOT fix billing/throttling`);
}

// Ordering: billing and throttling are matched BEFORE the generic auth branch,
// or the broad matcher swallows them and the user is told to sign in.
for (const name of FULL_POLICY_SURFACES) {
  const src = sources.get(name)!;
  const billing = src.indexOf("credit balance is too low");
  const genericAuth = src.indexOf("not authenticated");
  ok(billing > 0 && genericAuth > 0 && billing < genericAuth,
    `${name} matches billing BEFORE the generic auth branch`);
}


// ── visionOS: parity by SHARING, not by copying ────────────────────────────
//
// The rows above give visionOS the tvOS file because that is literally what it
// compiles. This asserts the arrangement itself, so "visionOS passes" can never
// mean "visionOS quietly grew its own copy that happens to match today".
{
  const spec = readFileSync(join(repo, "visionos/project.yml"), "utf8");
  ok(/path:\s*\.\.\/tvos\/YaverTV\/FailureSignals\.swift/.test(spec),
    "visionOS must COMPILE the tvOS FailureSignals.swift, not carry a copy");
  ok(!existsSync(join(repo, "visionos/YaverVision/FailureSignals.swift")),
    "visionos/YaverVision/FailureSignals.swift is back — a second `enum FailureSignals` " +
    "in the same module breaks the archive (\"filename used twice\"), which is exactly " +
    "how the 2026-08-03 visionOS deploy failed");
}

if (failures) {
  console.error(`\nfailureSignalParity: ${failures} FAILED — a cause one surface can name and another cannot`);
  process.exitCode = 1;
} else {
  console.log(`\nfailureSignalParity: ALL PASS across ${SURFACES.length} surfaces`);
}
