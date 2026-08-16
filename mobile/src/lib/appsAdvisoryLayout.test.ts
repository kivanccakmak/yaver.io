/**
 * appsAdvisoryLayout.test.ts — `npx tsx src/lib/appsAdvisoryLayout.test.ts`
 * No RN, no jest — reads the apps.tsx SOURCE (beaconParity.test.ts pattern)
 * and asserts the project action sheet can never bury its action lanes under
 * advisory text again.
 *
 * Incident 2026-07-28 (build-482 regression, measured live on the real app as
 * RN-web): /dev/compatibility returned an 8,212-char `guidance` string (~90 ×
 * "<dep> requires native code but is not present in the Yaver app."), the
 * sheet rendered it in a <Text> with NO numberOfLines above the lanes, and
 * "WebRTC Reload"/"Browser Reload" landed 280–340px below a fold the user
 * could not scroll past (body.scrollHeight === viewport). The 482 fix had
 * capped the `errors` channel but the identical content flowed unguarded
 * through `guidance` — classic duplicated-derive drift.
 *
 * Two invariants:
 *   (i)  every advisory <Text> that renders compatibility guidance / errors /
 *        warnings / lastBuildError / hermesCompilerError / missingLocalTools
 *        carries numberOfLines;
 *   (ii) the action lanes render BEFORE the advisory block, inside the scroll
 *        region — so advisory length only adds scrollable content underneath
 *        and can never push the route below the fold.
 *
 * Proven by breaking: remove one numberOfLines, or move the guidance <Text>
 * back above the lanes map, and this fails.
 */
import { readFileSync } from "fs";
import { join } from "path";

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

const src = readFileSync(join(__dirname, "..", "..", "app", "(tabs)", "apps.tsx"), "utf8");

// Scope to the action sheet — the same expressions legitimately appear in
// handlers (Alert.alert, action building) outside the render tree.
const sheetStart = src.indexOf("{/* Action sheet");
const sheetEnd = src.indexOf("{/* Vibing modal");
ok(sheetStart >= 0 && sheetEnd > sheetStart, "action sheet region markers found in apps.tsx");
const sheet = src.slice(sheetStart, sheetEnd);

// (i) Every advisory render is line-capped. For each occurrence of an advisory
// expression inside the sheet, the nearest preceding <Text opening tag must
// carry numberOfLines.
const advisoryExprs = [
  "compatibility.guidance",
  "compatibility.errors[0]",
  "compatibility.warnings[0]",
  "compatibility.lastBuildError",
  "compatibility.hermesCompilerError",
  "compatibility.missingLocalTools.join",
];
for (const expr of advisoryExprs) {
  let found = 0;
  let at = sheet.indexOf(expr);
  ok(at >= 0, `advisory expression ${expr} exists in the action sheet (renames must update this guard)`);
  while (at >= 0) {
    const tagStart = sheet.lastIndexOf("<Text", at);
    if (tagStart >= 0) {
      found++;
      const tag = sheet.slice(tagStart, sheet.indexOf(">", tagStart) + 1);
      ok(
        tag.includes("numberOfLines"),
        `<Text> rendering ${expr} has no numberOfLines — an unbounded advisory wall can bury the action lanes again (build 482 / 2026-07-28)`,
      );
    }
    at = sheet.indexOf(expr, at + 1);
  }
  ok(found > 0, `found a <Text> render for ${expr} in the action sheet`);
}

// (ii) The route wins in pixels: the lanes map renders before the first
// advisory expression, and both live inside the scroll region.
const scrollAt = sheet.indexOf("<ScrollView");
const lanesAt = sheet.indexOf("actionSheet?.actions.map");
const advisoryAt = Math.min(
  ...advisoryExprs.map((e) => sheet.indexOf(e)).filter((i) => i >= 0),
);
ok(scrollAt >= 0, "action sheet has a ScrollView region");
ok(lanesAt >= 0, "action sheet renders the action lanes");
ok(
  scrollAt < lanesAt,
  "the lanes live INSIDE the scroll region (a fixed advisory block above a scroll area is the build-482 shape)",
);
ok(
  lanesAt < advisoryAt,
  "the action lanes render BEFORE the advisory block — advisory content must never sit between the user and the route",
);

console.log(`\nappsAdvisoryLayout: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
