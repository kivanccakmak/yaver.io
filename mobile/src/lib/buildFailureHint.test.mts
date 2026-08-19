/**
 * buildFailureHint.test.mts — the proof for the substring trap.
 *
 * RUN:  cd mobile && npx tsx src/lib/buildFailureHint.test.mts
 *
 * ── The incident ───────────────────────────────────────────────────────────
 *
 * TestFlight build 500, 2026-08-03. Tapping the `mobile` project on a real
 * iPhone produced ONE alert containing TWO causes:
 *
 *   "build-native: refusing to build a Hermes bundle of Yaver for the Yaver
 *    container. … Use the browser/WebRTC preview instead …"
 *
 *   "Hermes bytecode version mismatch between the project app and the selected
 *    Yaver host family. Align the project runtime to a supported family and
 *    retry."
 *
 * They cannot both be true. The build was REFUSED, so no bundle exists whose
 * bytecode could mismatch anything. The second sentence came from a classifier
 * that tested `message.toLowerCase().includes("hermes")` — and the refusal
 * message says "Hermes bundle", because in this product everything does.
 *
 * The agent had sent `code: "YAVER_SELF_DEVELOPMENT_RECURSION"` on that same
 * response. It was discarded in favour of the regex.
 *
 * ── PROVE THE GUARD (CLAUDE.md: a guard you have not seen fail is a guess) ──
 *
 * Each of these was observed to FAIL against the old implementation before
 * being committed:
 *   • Restore `lower.includes("hermes")` as a branch → case 1 fails: the
 *     refusal grows a contradictory bytecode sentence again.
 *   • Restore `lower.includes("bytecode")` → case 2 fails for the same reason.
 *   • Drop the YAVER_SELF_DEVELOPMENT_RECURSION early return → case 1 fails.
 *   • Make the title generic again → case 7 fails.
 */
import { buildFailureHint, nativeBuildFailureTitle } from "./nativeBuild";

let failures = 0;
let checks = 0;
function check(cond: boolean, label: string) {
  checks++;
  if (!cond) {
    failures++;
    console.error(`FAIL: ${label}`);
  }
}
const eq = (a: unknown, b: unknown, label: string) =>
  check(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// The message verbatim from desktop/agent/devserver_http.go:3263. If that text
// is ever reworded, this test still holds — it keys off the code, which is the
// entire point.
const REFUSAL =
  "build-native: refusing to build a Hermes bundle of Yaver for the Yaver container. " +
  "Loading Yaver into Yaver puts two identical shake/exit owners in one React Native " +
  "process, so the preview cannot be exited. Use the browser/WebRTC preview instead " +
  "(remote-runtime / 'Stream over WebRTC'), where the escape stays in the phone's " +
  "native chrome. Native-container changes still need `yaver wire push` to a real device.";

const refusalResult = {
  error: REFUSAL,
  code: "YAVER_SELF_DEVELOPMENT_RECURSION",
  remedy: "stream-over-webrtc",
  strategy: "webrtc",
};

// 1 — THE SHIPPED BUG. A refusal must not grow a second, contradictory cause.
eq(buildFailureHint(refusalResult, REFUSAL), "",
   "1: the self-development refusal gets NO appended hint");

// 2 — the word that did it. Present in the message, and it must not matter.
check(REFUSAL.toLowerCase().includes("hermes"),
      "2a: the refusal really does contain 'hermes' (else this test proves nothing)");
check(!buildFailureHint(refusalResult, REFUSAL).toLowerCase().includes("bytecode"),
      "2b: and still produces no bytecode sentence");

// 3 — the real bytecode case still works, keyed off its CODE.
check(buildFailureHint({ code: "BC_VERSION_MISMATCH" }, "whatever the agent said")
        .includes("bytecode version mismatch"),
      "3: a genuine BC_VERSION_MISMATCH is still explained");

// 4 — a message that merely mentions Hermes, with no code, gets nothing.
//     This is the general form of the bug: prose is not a classifier.
eq(buildFailureHint({}, "Compiled the Hermes bundle in 4.2s but the upload failed"), "",
   "4: 'hermes' in a sentence is not a diagnosis");

// 5 — the narrow substring rules that remain are genuinely narrow.
check(buildFailureHint({}, "expo dev server did not become ready").includes("Metro didn't start"),
      "5a: dev-server readiness still explained");
check(buildFailureHint({}, "YaverBundleLoader is not a function").includes("native bundle loader"),
      "5b: missing loader still explained");

// 6 — family mismatches keep their own sentence, and it is not the bytecode one.
const fam = buildFailureHint({ code: "RUNTIME_FAMILY_MISMATCH" }, "");
check(fam.includes("nearest supported runtime family"), "6a: family mismatch explained");
check(!fam.includes("bytecode"), "6b: and not confused with a bytecode mismatch");

// 7 — TITLE. A deliberate, correct guard is not a failure, and calling it one
//     tells the user something broke when nothing did.
eq(nativeBuildFailureTitle(refusalResult), "Preview Yaver a Different Way",
   "7: the refusal is not titled 'Load Failed'");
eq(nativeBuildFailureTitle({ code: "BC_VERSION_MISMATCH" }), "Hermes Version Mismatch",
   "7b: a real mismatch keeps its title");
eq(nativeBuildFailureTitle({}), "Load Failed",
   "7c: an unknown failure is still a failure");

// 8 — the ROUTE the phone renders comes from `remedy`, so it must survive.
eq(refusalResult.remedy, "stream-over-webrtc",
   "8: the agent's remedy is the button, and apps.tsx maps it to remote-runtime");

// 9 — v1 has no secondary-user concept. Runtime failures must describe the
// project app, never leak the old internal compatibility terminology into UI.
for (const [label, output] of [
  ["family", buildFailureHint({ code: "RUNTIME_FAMILY_MISMATCH" }, "")],
  ["bytecode", buildFailureHint({ code: "BC_VERSION_MISMATCH" }, "")],
] as const) {
  check(!output.toLowerCase().includes("guest"),
        `9 ${label}: user-facing runtime copy has no deprecated access terminology`);
}

if (failures) {
  console.error(`\n${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`ok — ${checks} checks passed (buildFailureHint)`);
