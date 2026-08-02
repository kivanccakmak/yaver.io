/**
 * Guards for vibeVerdict — the decisions behind the vibe closed loop.
 *
 * Every case below is a bug that actually shipped in the harness and made a
 * WORKING product look broken. Run: npx tsx web/lib/vibeVerdict.test.ts
 */
import { classifyVibeColor, looksRendered, modalColor, samplePoints, verdictFor } from "./vibeVerdict";

let failures = 0;
const eq = (got: unknown, want: unknown, label: string) => {
  if (got === want) console.log(`ok   ${label}`);
  else { console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); failures++; }
};
const ok = (c: unknown, label: string) => eq(Boolean(c), true, label);

// ── classification ────────────────────────────────────────────────────────
eq(classifyVibeColor([255, 0, 0]), "red", "pure red classifies");
eq(classifyVibeColor([0, 0, 0]), "black", "pure black classifies");
eq(classifyVibeColor([23, 23, 23]), "black", "#171717 (the app's dark card) is black");
eq(classifyVibeColor([0, 200, 0]), "green", "pure green classifies");

// NO FALSE PASS: the app paints error chrome in red-ish tones. A loose
// threshold would let a failure banner masquerade as a successful vibe.
eq(classifyVibeColor([180, 150, 150]), "other(180,150,150)",
  "a washed-out red-ish tone is NOT red — error chrome must not pass as success");
eq(classifyVibeColor([0, 135, 0]), "green",
  "rgb(0,135,0) IS green — which is exactly why the WebRTC loop never probes for it");
eq(classifyVibeColor(null), "unknown", "null is unknown, not a colour");
eq(classifyVibeColor([1, 2]), "unknown", "a short tuple is unknown");
eq(classifyVibeColor([NaN, 0, 0]), "unknown", "NaN is unknown rather than silently 0");

// ── THE BUG THAT COST TWO TWELVE-MINUTE RUNS ─────────────────────────────
// A single band at 55% height crossed the sign-in buttons (#1a1a1a), so a
// fully red screen sampled as black and the loop reported failure for a vibe
// that had plainly worked.
{
  const W = 100, H = 100;
  // Frame: red background, with a dark button band across the middle.
  const pixelAt = (x: number, y: number): number[] =>
    (y > H * 0.5 && y < H * 0.6) ? [26, 26, 26] : [255, 0, 0];

  const oneBand = [];
  for (let x = 10; x < 90; x += 4) oneBand.push(pixelAt(x, Math.floor(H * 0.55)));
  eq(classifyVibeColor(modalColor(oneBand)), "black",
    "control: the OLD one-band sampler reads the buttons and says black");

  const grid = samplePoints(W, H).map(([x, y]) => pixelAt(x, y));
  eq(classifyVibeColor(modalColor(grid)), "red",
    "the GRID sampler reads the background and says red — the actual fix");
}

// ── sampling ──────────────────────────────────────────────────────────────
ok(samplePoints(100, 100).length > 50, "a grid produces many points");
ok(samplePoints(100, 100).every(([x, y]) => x >= 5 && y >= 5 && x < 95 && y < 95),
  "insets skip the device-frame chrome at the edges");
eq(samplePoints(0, 0).length, 0, "a zero-size frame yields no points rather than throwing");
eq(modalColor([]).join(","), "0,0,0", "an empty sample set is not a crash");

// ── empty panel vs rendered app ───────────────────────────────────────────
// A blank black rectangle and a black login screen classify identically, so
// "black" alone can be a preview that never loaded agreeing with the test.
eq(looksRendered(Array.from({ length: 200 }, () => [0, 0, 0])), false,
  "a single-colour frame is an EMPTY panel, not a rendered app");
ok(looksRendered([[0, 0, 0], [255, 255, 255], [124, 102, 255], [26, 26, 26]]),
  "text, buttons and borders make a real UI distinguishable");

// ── verdicts ──────────────────────────────────────────────────────────────
eq(verdictFor({ reachedTarget: true, reverted: true }).verdict, "PIXELS",
  "both halves observed = PIXELS, the only pass");
eq(verdictFor({ reachedTarget: true, reverted: false, reason: "never reverted" }).verdict, "NAMED",
  "a stated cause is a degrade, not a defect");
eq(verdictFor({ reachedTarget: false, reverted: false, reason: "" }).verdict, "SILENT",
  "no cause at all is the only true failure");
ok(/no stated cause/.test(verdictFor({ reachedTarget: false, reverted: false }).reason),
  "…and SILENT says so rather than rendering an empty string");

if (failures) { console.error(`\nvibeVerdict: ${failures} FAILED`); process.exitCode = 1; }
else console.log("\nvibeVerdict: ALL PASS");
