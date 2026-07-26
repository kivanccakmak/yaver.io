// runnerAuthFlow.test.ts — pins the flow-kind detection to the two REAL
// URL shapes. Plain-node harness (same as devEventLine.test.ts).
// Run: npx tsx lib/runnerAuthFlow.test.ts (from web/)

import { runnerAuthFlowKind } from "./runnerAuthFlow";

function eq(got: unknown, want: unknown, label: string) {
  if (got !== want) {
    console.error(`FAIL ${label}: got ${String(got)}, want ${String(want)}`);
    process.exitCode = 1;
  } else {
    console.log(`ok ${label}`);
  }
}

// The observed claude --claudeai URL (2026-07-27): platform code callback.
eq(
  runnerAuthFlowKind(
    "https://claude.com/cai/oauth/authorize?code=true&client_id=x&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Aprofile&code_challenge=y&state=z",
  ),
  "code-paste",
  "claudeai platform-code flow → code-paste",
);

// A genuine localhost-redirect flow → the callback box is right.
eq(
  runnerAuthFlowKind(
    "https://auth.example.com/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A39131%2Fcallback&response_type=code",
  ),
  "localhost-callback",
  "localhost redirect → localhost-callback",
);

eq(runnerAuthFlowKind(""), "unknown", "empty → unknown");
eq(runnerAuthFlowKind(undefined), "unknown", "undefined → unknown");
eq(
  runnerAuthFlowKind("https://auth.example.com/authorize?redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb"),
  "unknown",
  "hosted non-claude redirect → unknown (show both affordances)",
);

// ── runnerAuthLivenessLine — the anti-spinner narration ────────────────────

import { runnerAuthLivenessLine } from "./runnerAuthFlow";

const t0 = 1_000_000_000_000;
eq(runnerAuthLivenessLine(t0, undefined, undefined), null, "no startedAt → nothing truthful to say");
eq(
  runnerAuthLivenessLine(t0 + 42_000, t0, undefined),
  "Started 42s ago · the CLI has printed nothing yet",
  "no output yet → says so instead of spinning",
);
eq(
  runnerAuthLivenessLine(t0 + 134_000, t0, t0 + 131_000),
  "Started 2m 14s ago · CLI last output 3s ago",
  "live CLI → elapsed + last-output narration",
);
eq(
  runnerAuthLivenessLine(t0, t0, t0 - 5_000),
  "Started 0s ago · the CLI has printed nothing yet",
  "stale lastOutputAt from an earlier session is ignored",
);
