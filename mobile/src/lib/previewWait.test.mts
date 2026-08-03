/**
 * previewWait.test.mts — RUN: cd mobile && npx tsx src/lib/previewWait.test.mts
 *
 * Replays the sfmg log tail captured off a real iPhone (TestFlight build 500,
 * 2026-08-03) frame by frame, and asserts the surface would have said
 * something true at every moment it was actually black.
 *
 * PROVE THE GUARD — each observed to fail before being committed:
 *   • Make previewWaitLine return null when startedAt is set → case 1 fails
 *     (that IS the shipped behaviour: nothing rendered for two minutes).
 *   • Drop "last output" from the detail → case 4 fails.
 *   • Let meaningfulPreviewLine return the last line verbatim → case 6 fails,
 *     the headline becomes a `three` package warning.
 *   • Return a panel after content loads → case 8 fails, which would cover a
 *     working app with a placeholder.
 */
import { meaningfulPreviewLine, previewWaitLine, shortElapsed } from "./previewWait";

let failures = 0;
let checks = 0;
function check(cond: boolean, label: string) {
  checks++;
  if (!cond) { failures++; console.error(`FAIL: ${label}`); }
}
const eq = (a: unknown, b: unknown, l: string) =>
  check(a === b, `${l} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const T0 = 1_700_000_000_000; // 18:21:00, the moment the preview opened.

// The real tail, in order, as photographed from the phone.
const SFMG = [
  "queued",
  "Starting project at /root/Workspace/sfmg",
  "Using src/app as the root directory for Expo Router.",
  "metro bundling",
  "Starting Metro Bundler",
  "listening",
  "Waiting on http://localhost:8081",
  "Logs for your project will appear below.",
  "Web node_modules/expo-router/entry.js 0.0% (0/1)",
  "ready 100%",
  "Web Bundled 4844ms node_modules/expo-router/entry.js (2186 modules)",
];

// 1 — THE SHIPPED BUG. At 40 seconds in, the screen was black and silent.
//     It must now say something, and that something must be true.
const at40 = previewWaitLine({
  contentLoaded: false, startedAt: T0, lastOutputAt: T0 + 30_000,
  now: T0 + 40_000, logs: SFMG.slice(0, 5), workDir: "/root/Workspace/sfmg",
});
check(at40 !== null, "1: there IS something to render at 40s (was: nothing, for 2 minutes)");
eq(at40?.title, "Starting Metro Bundler", "2: the headline is the box's own words");
check((at40?.detail || "").includes("40s elapsed"), "3: elapsed is shown");
check((at40?.detail || "").includes("last output 10s ago"), "4: last progress is shown");
eq(at40?.stalled, false, "5: 10s of quiet is not a stall");

// 6 — the sfmg log tail ended in three screens of package warnings. The
//     headline must not become one of them.
const withWarnings = [
  ...SFMG,
  "WARN  The package /root/Workspace/sfmg/node_modules/three contains an invalid package.json configuration.",
  "WARN  Consider raising this issue with the package maintainer(s).",
];
eq(meaningfulPreviewLine(withWarnings),
   "Web Bundled 4844ms node_modules/expo-router/entry.js (2186 modules)",
   "6: progress beats the last warning");

// 7 — SILENCE IS STATED. A box that has printed nothing yet is a fact, and
//     "no output yet" is what a user can act on.
const quiet = previewWaitLine({
  contentLoaded: false, startedAt: T0, lastOutputAt: null,
  now: T0 + 45_000, logs: [], workDir: "/root/Workspace/sfmg",
});
check((quiet?.detail || "").includes("no output yet"), "7a: silence is named, not hidden");
check((quiet?.title || "").includes("/root/Workspace/sfmg"), "7b: and it says WHERE");
eq(quiet?.stalled, true, "7c: 45s of nothing is a stall worth flagging");

// 8 — NEVER cover a working app. A status panel over loaded content is the
//     surprise-re-render defect wearing a helpful face.
eq(previewWaitLine({
  contentLoaded: true, startedAt: T0, lastOutputAt: T0 + 1000,
  now: T0 + 200_000, logs: SFMG,
}), null, "8: once the app has painted, the panel is gone");

// 9 — nothing started, nothing to say. No spinner over an idle surface.
eq(previewWaitLine({ contentLoaded: false, startedAt: null, lastOutputAt: null, now: T0, logs: [] }),
   null, "9: an unstarted preview narrates nothing");

// 10 — the real two-minute case this whole file exists for.
const at2min = previewWaitLine({
  contentLoaded: false, startedAt: T0, lastOutputAt: T0 + 100_000,
  now: T0 + 120_000, logs: SFMG, workDir: "/root/Workspace/sfmg",
});
check((at2min?.detail || "").includes("2:00 elapsed"), "10: two minutes reads as 2:00, not 120s");

// 11 — formatting.
eq(shortElapsed(0), "0s", "11a");
eq(shortElapsed(59_400), "59s", "11b");
eq(shortElapsed(60_000), "1:00", "11c");
eq(shortElapsed(134_000), "2:14", "11d");
eq(shortElapsed(-5), "0s", "11e: a clock skew never renders a negative age");

if (failures) {
  console.error(`\n${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`ok — ${checks} checks passed (previewWait)`);
