/**
 * promptFramingParity.test.ts — `npx tsx src/lib/promptFramingParity.test.ts`.
 * No RN, no jest — reads the GO source and compares it to the TS constants.
 *
 * WHY THIS EXISTS. The rule "the user never sees Yaver's prompt frame" is
 * enforced in Go (desktop/agent/prompt_echo_guard.go keeps the frame out of the
 * stream in the first place). The TS side is a fallback for phones talking to
 * an OLDER agent — and a fallback that has drifted is worse than none, because
 * it looks like coverage.
 *
 * It HAD drifted. app/(tabs)/tasks.tsx carried its own copy of the marker list
 * that never learned about `promptEchoSentinel`, so for every chat-mode task —
 * the lane where the sentinel is the ONLY boundary present — the strip was
 * structurally incapable of working, and the wall rendered in the bubble.
 * FeedbackOverlay.tsx carried a third copy with no marker slicing at all.
 *
 * Reading the Go file rather than hard-coding the expected values is the whole
 * point: a constant changed on the agent side must fail HERE, not on a user's
 * phone.
 *
 * Prove it by breaking it: delete an entry from SYSTEM_CONTEXT_END_MARKERS in
 * promptFraming.ts and re-run — this must fail.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  SYSTEM_CONTEXT_END_MARKERS,
  YAVER_PROMPT_BOUNDARY,
  containsYaverFraming,
  sliceAfterFrameBoundary,
} from "./promptFraming";

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

const goSource = readFileSync(
  join(__dirname, "../../../desktop/agent/result_cleanup.go"),
  "utf8",
);

// --- 1. the sentinel is byte-identical to the agent's ------------------------
{
  const m = goSource.match(/promptEchoSentinel\s*=\s*"([^"]+)"/);
  ok(m !== null, "could not find promptEchoSentinel in result_cleanup.go");
  if (m) {
    ok(
      m[1] === YAVER_PROMPT_BOUNDARY,
      `sentinel drift: Go has ${JSON.stringify(m[1])}, TS has ${JSON.stringify(YAVER_PROMPT_BOUNDARY)}`,
    );
  }
}

// --- 2. the marker list covers every marker the agent slices on --------------
{
  const block = goSource.match(/systemContextEndMarkers\s*=\s*\[\]string\{([\s\S]*?)\n\}/);
  ok(block !== null, "could not find systemContextEndMarkers in result_cleanup.go");
  if (block) {
    const goMarkers = [...block[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
    // promptEchoSentinel appears as an identifier, not a literal — account for it.
    const expected = [YAVER_PROMPT_BOUNDARY, ...goMarkers];
    const missing = expected.filter((x) => !SYSTEM_CONTEXT_END_MARKERS.includes(x));
    ok(
      missing.length === 0,
      `TS marker list is missing Go markers: ${JSON.stringify(missing)} — the phone cannot strip what it does not know about`,
    );
    const extra = SYSTEM_CONTEXT_END_MARKERS.filter((x) => !expected.includes(x));
    ok(
      extra.length === 0,
      `TS marker list has markers Go does not: ${JSON.stringify(extra)} — a stale marker can truncate a real answer`,
    );
  }
}

// --- 3. behaviour: slice after the LAST boundary, never the first ------------
{
  const echoed =
    "make it red\n\n[Yaver wrapper capabilities]\n…\n" +
    YAVER_PROMPT_BOUNDARY +
    "\n[Screen the user is looking at] route: /settings\n" +
    YAVER_PROMPT_BOUNDARY +
    "\nDone — Header.tsx now uses the accent colour.";
  const got = sliceAfterFrameBoundary(echoed);
  ok(
    !got.includes(YAVER_PROMPT_BOUNDARY) && !got.includes("[Yaver wrapper capabilities]"),
    `sliceAfterFrameBoundary left framing behind: ${JSON.stringify(got)}`,
  );
  ok(
    got.includes("Done — Header.tsx now uses the accent colour."),
    `sliceAfterFrameBoundary ate the answer: ${JSON.stringify(got)}`,
  );
}

// --- 4. an unframed answer is never truncated -------------------------------
{
  const plain = "All three tests pass now.";
  ok(
    sliceAfterFrameBoundary(plain) === plain,
    "an answer with no boundary must pass through untouched — truncating it is a worse bug than the one we are fixing",
  );
}

// --- 5. the readback guard recognises framing --------------------------------
{
  ok(containsYaverFraming("[Yaver wrapper capabilities]\nYou are running inside Yaver"), "must catch wrapper capabilities");
  ok(containsYaverFraming(YAVER_PROMPT_BOUNDARY), "must catch the bare sentinel");
  ok(!containsYaverFraming("Done — the header is sticky now."), "must not refuse to speak a real answer");
}

console.log(`\npromptFramingParity: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
