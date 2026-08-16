/**
 * Guards for projectMachineMismatch.
 *
 * Reproduces the owner's 2026-08-02 split: the project list was read from the
 * runner box while the render probe targeted a different machine, so the render
 * box truthfully reported a project it had never been asked about.
 *
 * Run: npx tsx web/lib/projectMachineMismatch.test.ts
 */
import { detectProjectMachineMismatch, shouldOfferRenderOnSource } from "./projectMachineMismatch";

function eq(got: unknown, want: unknown, label: string) {
  if (got !== want) {
    console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    process.exitCode = 1;
  } else {
    console.log(`ok   ${label}`);
  }
}
const ok = (c: unknown, label: string) => eq(Boolean(c), true, label);

// The live split: list from the runner box, render on another machine.
const LIVE = {
  projectName: "yaver / mobile",
  sourceDeviceId: "dev-runner",
  sourceName: "runner-box",
  renderDeviceId: "dev-render",
  renderName: "render-box",
};

const live = detectProjectMachineMismatch(LIVE);
ok(live.mismatch, "a runner/render split over one project list is a mismatch");
ok(/came from render-box/i.test(live.reason) === false, "the reason attributes the LIST to the right box");
ok(/came from runner-box/i.test(live.reason), "…namely the box the list was read from");
ok(/never asked/i.test(live.reason), "it explains WHY the render box could not know");
ok(/render on runner-box/i.test(live.action), "the route is to render where the project actually is");
eq(live.sourceDeviceId, "dev-runner", "the source id is carried so the UI can act on it");

// ── NO FALSE REDS ─────────────────────────────────────────────────────────
// A single box is not a routing problem. Saying so would send the user chasing
// a machine split they do not have.
eq(detectProjectMachineMismatch({ ...LIVE, renderDeviceId: "dev-runner", renderName: "runner-box" }).mismatch,
  false, "NO FALSE RED: one box runs and renders — nothing to route");

// Half the facts is not a diagnosis.
eq(detectProjectMachineMismatch({ ...LIVE, sourceDeviceId: "" }).mismatch, false,
  "NO FALSE RED: unknown source device → stay silent");
eq(detectProjectMachineMismatch({ ...LIVE, renderDeviceId: null }).mismatch, false,
  "NO FALSE RED: unknown render device → stay silent");
eq(detectProjectMachineMismatch({}).mismatch, false, "empty input is silent, not a throw");
eq(detectProjectMachineMismatch({}).reason, "", "…and carries no prose");

// Whitespace must not manufacture a difference between one machine and itself.
eq(detectProjectMachineMismatch({ sourceDeviceId: " dev-a ", renderDeviceId: "dev-a" }).mismatch, false,
  "NO FALSE RED: ids are trimmed before comparison");

// Names are cosmetic; the ID decides. A box with no nickname still works.
const unnamed = detectProjectMachineMismatch({ sourceDeviceId: "dev-a", renderDeviceId: "dev-b" });
ok(unnamed.mismatch, "a mismatch is detected from ids alone");
ok(unnamed.reason.includes("dev-a") && unnamed.reason.includes("dev-b"),
  "…and falls back to ids when there are no nicknames");

// No project selected yet: still a real mismatch, phrased generically.
const noProject = detectProjectMachineMismatch({ ...LIVE, projectName: "" });
ok(noProject.mismatch, "the mismatch does not depend on a project being chosen");
ok(/The selected project/i.test(noProject.reason), "…and reads sensibly without a name");

// ── the gate ──────────────────────────────────────────────────────────────
ok(shouldOfferRenderOnSource("project-missing", LIVE),
  "a project-missing failure across two boxes offers the cross-machine route");
eq(shouldOfferRenderOnSource("project-missing", { ...LIVE, renderDeviceId: "dev-runner" }), false,
  "NO FALSE RED: project-missing on ONE box is a real missing project, not a routing problem");
eq(shouldOfferRenderOnSource("relay-presence", LIVE), false,
  "an unreachable box is not a project-routing problem");
eq(shouldOfferRenderOnSource("other", LIVE), false,
  "a build failure is not a project-routing problem");
eq(shouldOfferRenderOnSource(null, LIVE), false, "no failure kind → no route offered");

if (process.exitCode) console.error("\nprojectMachineMismatch: FAILED");
else console.log("\nprojectMachineMismatch: ALL PASS");
