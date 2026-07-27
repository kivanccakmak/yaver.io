// capabilityGap.test.mts — the named-capability-gap layer, both surfaces.
// Run: node --experimental-strip-types --test src/lib/capabilityGap.test.mts
//
// Three jobs:
//  1. behavior — the object the Go producer actually emits renders as a
//     sentence + a tappable route;
//  2. wire-contract drift — the code and the JSON keys are read out of
//     desktop/agent/*.go, so a rename there fails HERE instead of blanking
//     both clients at runtime;
//  3. parity — the two capabilityGap.ts twins are byte-identical, and every
//     surface that can hit the failure actually consumes them. A signal with
//     no consumer is not shipped.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_INSUFFICIENT_DISK,
  CAPABILITY_TOOLCHAIN_MISSING,
  capabilityGapFromDevEvent,
  capabilityGapFromError,
  capabilityGapFromStatus,
  gapBody,
  gapConfirmPreview,
  gapConstraint,
  gapFixLabel,
  gapHeadroomLine,
  gapInstallTool,
  gapIsDiskBlocked,
  gapReclaimLabel,
  gapRetriesAfterFix,
  gapState,
  gapStreamPath,
  gapTitle,
  gapWarning,
  parseCapabilityGap,
} from "./capabilityGap.ts";

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = join(mobileRoot, "..");

// The exact object desktop/agent/capability_gap.go produces for the 2026-07-26
// incident (see TestCapabilityGapNamesFlutterAndRoutesToTheInstall).
const FLUTTER_GAP = {
  code: "capability.toolchain_missing",
  capability: "flutter",
  summary: "Flutter isn't installed on this machine.",
  detail:
    "Yaver can install it here, no sudo needed. The download streams into this panel, and the preview starts by itself when it finishes. Same thing from a terminal: `yaver install flutter`.",
  fix: {
    label: "Install Flutter",
    method: "POST",
    path: "/install/flutter",
    stream: "install:flutter",
    est: "~1.2 GB SDK · usually 3–10 min",
    retry: true,
  },
};

test("the headline: a named sentence, an Install button, a stream to watch", () => {
  const gap = parseCapabilityGap(FLUTTER_GAP);
  assert.ok(gap, "the agent's own payload must parse");
  assert.equal(gapTitle(gap!), "Flutter isn't installed on this machine.");
  assert.match(gapFixLabel(gap!)!, /^Install Flutter/);
  assert.match(gapFixLabel(gap!)!, /1\.2 GB/, "the size belongs on the button, not in a log");
  assert.equal(gapStreamPath(gap!), "/streams/install:flutter");
  assert.equal(gapInstallTool(gap!), "flutter");
  assert.equal(gapRetriesAfterFix(gap!), true, "the fix must return the user to what they were doing");
  assert.match(gapBody(gap!), /streams into this panel/);
});

test("every carrier hands back the same object", () => {
  assert.deepEqual(capabilityGapFromDevEvent({ type: "error", message: "boom", gap: FLUTTER_GAP }), parseCapabilityGap(FLUTTER_GAP));
  assert.deepEqual(capabilityGapFromStatus({ running: false, error: "boom", capabilityGap: FLUTTER_GAP }), parseCapabilityGap(FLUTTER_GAP));
  assert.deepEqual(capabilityGapFromError(Object.assign(new Error("boom"), { capabilityGap: FLUTTER_GAP })), parseCapabilityGap(FLUTTER_GAP));
  // And nothing where there is nothing.
  assert.equal(capabilityGapFromDevEvent({ type: "log", logLine: "hello" }), null);
  assert.equal(capabilityGapFromStatus({ running: true }), null);
  assert.equal(capabilityGapFromError(new Error("plain")), null);
  assert.equal(capabilityGapFromError(null), null);
});

test("no fix ⇒ the constraint is named, and NO button is offered", () => {
  const gap = parseCapabilityGap({
    code: CAPABILITY_TOOLCHAIN_MISSING,
    capability: "wda",
    summary: "wda isn't installed on this machine.",
    constraint: "Yaver has no install recipe for wda on this machine, so there is nothing to tap here.",
  });
  assert.ok(gap);
  assert.equal(gapFixLabel(gap!), null, "a button with no route is the 404 lie");
  assert.equal(gapStreamPath(gap!), null);
  assert.equal(gapRetriesAfterFix(gap!), false);
  assert.match(gapBody(gap!), /no install recipe for wda/);
});

test("a half-formed fix renders as NO button, never as a silent install", () => {
  // A fix without a stream would start a 1.2 GB download the user cannot see —
  // the same defect as a silent `serve`.
  const noStream = parseCapabilityGap({ ...FLUTTER_GAP, fix: { ...FLUTTER_GAP.fix, stream: "" } });
  assert.ok(noStream);
  assert.equal(gapFixLabel(noStream!), null);
  const noPath = parseCapabilityGap({ ...FLUTTER_GAP, fix: { ...FLUTTER_GAP.fix, path: "" } });
  assert.equal(gapFixLabel(noPath!), null);
  // And a payload with no code/summary is not a gap at all.
  assert.equal(parseCapabilityGap({ capability: "flutter" }), null);
  assert.equal(parseCapabilityGap(null), null);
  assert.equal(parseCapabilityGap("flutter missing"), null);
});

// --- PLATFORM: a constraint is a STATE, not an error and not a dead button ---

// The Windows box that got an "Install Flutter" button whose install would
// report success and leave nothing on PATH. The agent now refuses it; the
// client must render the sentence and STOP SPINNING, which is what gapState
// exists to make unambiguous.
test("a platform constraint renders as a first-class state, never as a button", () => {
  const gap = parseCapabilityGap({
    code: CAPABILITY_TOOLCHAIN_MISSING,
    capability: "xcodebuild",
    summary: "Xcode isn't installed on this machine.",
    constraint:
      "Xcode only exists on macOS — Apple ships no Xcode or iOS simulator runtime for linux, so there is nothing Yaver could install here.",
  });
  assert.ok(gap);
  assert.equal(gapState(gap!), "constrained");
  assert.equal(gapFixLabel(gap!), null, "a constrained gap must offer no button");
  assert.match(gapConstraint(gap!)!, /only exists on macOS/);
  assert.equal(gapWarning(gap!), null);
  // And a FIXABLE gap must not read as constrained — the guard in both directions.
  assert.equal(gapState(parseCapabilityGap(FLUTTER_GAP)!), "fixable");
  assert.equal(gapConstraint(parseCapabilityGap(FLUTTER_GAP)!), null);
});

// --- RESOURCE: warn without removing the button; refuse with a way out ------

const TIGHT_GAP = {
  ...FLUTTER_GAP,
  warning:
    "Heads up — the install fits (2.0 GB needed, 3.2 GB free on /opt) but the FIRST build after it typically needs another 2.0 GB — you may run out mid-build.",
  resource: { path: "/opt", freeBytes: 3355443200, freeHuman: "3.2 GB", needBytes: 3221225472, needHuman: "3.0 GB", level: "tight" },
  reclaim: {
    label: "Free up space — about 12.4 GB reclaimable",
    method: "POST",
    path: "/storage/reclaim",
    stream: "",
    est: "12.4 GB in caches and build artifacts · you approve each item",
    retry: true,
    confirm: { method: "GET", path: "/storage/scan", field: "confirm", prompt: "Review every path and size first." },
  },
};

test("a thin-headroom warning rides BESIDE the fix — warning is not refusal", () => {
  const gap = parseCapabilityGap(TIGHT_GAP);
  assert.ok(gap);
  assert.equal(gapState(gap!), "fixable-with-warning");
  assert.ok(gapFixLabel(gap!), "the button must survive a warning; the user decides");
  assert.match(gapWarning(gap!)!, /mid-build/);
  assert.equal(gapConstraint(gap!), null, "a warning is not a constraint");
  assert.match(gapHeadroomLine(gap!)!, /3\.2 GB free on \/opt/);
});

test("a disk refusal is a DIFFERENT code and ships the route that fixes it", () => {
  const gap = parseCapabilityGap({
    code: CAPABILITY_INSUFFICIENT_DISK,
    capability: "flutter",
    summary: "Flutter isn't installed on this machine.",
    constraint: "Flutter needs about 2.0 GB to install and 1.0 GB of headroom — /opt has 340.0 MB free.",
    resource: { path: "/opt", freeBytes: 356515840, freeHuman: "340.0 MB", needBytes: 3221225472, needHuman: "3.0 GB", reclaimableBytes: 13314398617, reclaimableHuman: "12.4 GB", level: "insufficient" },
    reclaim: TIGHT_GAP.reclaim,
  });
  assert.ok(gap);
  assert.equal(gapIsDiskBlocked(gap!), true);
  assert.equal(gapFixLabel(gap!), null, "installing is not the remedy for a full disk");
  assert.equal(gapState(gap!), "constrained");
  assert.match(gapReclaimLabel(gap!)!, /12\.4 GB reclaimable/);
  assert.match(gapHeadroomLine(gap!)!, /340\.0 MB free on \/opt/);
  assert.match(gapHeadroomLine(gap!)!, /12\.4 GB reclaimable/);
  // The toolchain gap must NOT read as disk-blocked — the guard both ways.
  assert.equal(gapIsDiskBlocked(parseCapabilityGap(FLUTTER_GAP)!), false);
});

test("a destructive route is unusable without its preview — no silent deletes", () => {
  const gap = parseCapabilityGap(TIGHT_GAP);
  const preview = gapConfirmPreview(gap!.reclaim);
  assert.ok(preview, "the reclaim route MUST name a preview the UI has to fetch first");
  assert.equal(preview!.path, "/storage/scan");
  assert.equal(preview!.field, "confirm");
  // An install fix is not confirm-gated and must not pretend to be.
  assert.equal(gapConfirmPreview(parseCapabilityGap(FLUTTER_GAP)!.fix), null);
  // A "confirm" with no preview route would render a review affordance that
  // reviews nothing — refuse the whole fix rather than render half a gate.
  const noPreview = parseCapabilityGap({ ...TIGHT_GAP, reclaim: { ...TIGHT_GAP.reclaim, stream: "", confirm: { method: "GET", path: "", field: "confirm", prompt: "" } } });
  assert.equal(gapReclaimLabel(noPreview!), null);
});

test("the wire contract is READ from the agent, not restated here", () => {
  const codes = readFileSync(join(repoRoot, "desktop/agent/reason_codes.go"), "utf8");
  assert.match(
    codes,
    new RegExp(`ReasonCapabilityToolchainMissing\\s*=\\s*"${CAPABILITY_TOOLCHAIN_MISSING}"`),
    "reason code renamed in Go — both clients would silently stop matching",
  );

  const producer = readFileSync(join(repoRoot, "desktop/agent/capability_gap.go"), "utf8");
  for (const key of ["json:\"code\"", "json:\"capability\"", "json:\"summary\"", "json:\"detail,omitempty\"", "json:\"fix,omitempty\"", "json:\"constraint,omitempty\""]) {
    assert.ok(producer.includes(key), `CapabilityGap lost ${key} — parseCapabilityGap reads it`);
  }
  for (const key of ["json:\"label\"", "json:\"method\"", "json:\"path\"", "json:\"stream\"", "json:\"est,omitempty\"", "json:\"retry\""]) {
    assert.ok(producer.includes(key), `GapFix lost ${key} — the route would not render`);
  }
  // The platform + resource lane (2026-07-27).
  assert.match(
    codes,
    new RegExp(`ReasonCapabilityInsufficientDisk\\s*=\\s*"${CAPABILITY_INSUFFICIENT_DISK}"`),
    "the disk reason code renamed in Go — clients would render Install for a full disk",
  );
  for (const key of ["json:\"warning,omitempty\"", "json:\"resource,omitempty\"", "json:\"reclaim,omitempty\"", "json:\"confirm,omitempty\""]) {
    assert.ok(producer.includes(key), `CapabilityGap lost ${key} — the warning/reclaim lane goes dark`);
  }
  const resources = readFileSync(join(repoRoot, "desktop/agent/capability_resources.go"), "utf8");
  for (const key of ["json:\"freeBytes\"", "json:\"freeHuman\"", "json:\"needBytes,omitempty\"", "json:\"level\""]) {
    assert.ok(resources.includes(key), `CapabilityResource lost ${key} — gapHeadroomLine reads it`);
  }
  // The three verdict values the client branches on are the agent's, not ours.
  for (const level of ["\"ok\"", "\"tight\"", "\"insufficient\""]) {
    assert.ok(resources.includes(level), `capability_resources.go lost verdict level ${level}`);
  }

  // PLATFORM: the matrix must still declare the two truths that cost the most
  // to get wrong — Flutter installable on linux/arm64, Apple toolchain not
  // installable anywhere but darwin.
  const platform = readFileSync(join(repoRoot, "desktop/agent/capability_platform.go"), "utf8");
  assert.match(platform, /capabilityToolMatrix\s*=\s*map\[string\]capabilityToolSpec/, "the per-tool table moved");
  assert.match(platform, /func darwinOnly\(/, "the Apple-only predicate is gone");
  assert.match(platform, /emulatorHostSupported/, "the emulator row must reuse the installer's own truth, not a copy");

  // The carriers.
  const devserver = readFileSync(join(repoRoot, "desktop/agent/devserver.go"), "utf8");
  assert.match(devserver, /Gap\s+\*CapabilityGap\s+`json:"gap,omitempty"`/, "DevServerEvent lost its gap field");
  assert.match(devserver, /CapabilityGap\s+\*CapabilityGap\s+`json:"capabilityGap,omitempty"`/, "DevServerStatus lost its gap field");
  const devHttp = readFileSync(join(repoRoot, "desktop/agent/devserver_http.go"), "utf8");
  assert.match(devHttp, /"capabilityGap"\]?\s*=?\s*gap|payload\["capabilityGap"\] = gap/, "the 412 stopped carrying the gap");
});

test("web/mobile twins are byte-identical below the header comment", () => {
  const strip = (src: string) => src.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n").trim();
  const mobile = strip(readFileSync(join(mobileRoot, "src/lib/capabilityGap.ts"), "utf8"));
  const web = strip(readFileSync(join(repoRoot, "web/lib/capabilityGap.ts"), "utf8"));
  assert.equal(
    web,
    mobile,
    "capabilityGap twins drifted — sync web/lib/capabilityGap.ts and mobile/src/lib/capabilityGap.ts",
  );
});

test("every surface that can hit the failure consumes it (no dead seam)", () => {
  // Both browser-preview implementations on mobile. A fix that lands in one of
  // two is not landed — that drift shipped a broken heartbeat, dropped SSE
  // frames and a dead shake gesture in apps.tsx while DevPreview.tsx was fine.
  for (const rel of ["app/(tabs)/apps.tsx", "src/components/DevPreview.tsx"]) {
    const src = readFileSync(join(mobileRoot, rel), "utf8");
    // Call sites, not substrings: a renamed helper must fail HERE. `/gapFix/`
    // would happily match `gapFixXX` and pass while the screen was broken.
    assert.match(src, /from "[^"]*capabilityGap"/, `${rel} must import the renderer`);
    assert.match(src, /capabilityGapFromDevEvent\(/, `${rel} must read the gap off the SSE frame`);
    assert.match(src, /capabilityGapFromStatus\(/, `${rel} must read the gap off the status poll`);
    assert.match(src, /gapFixLabel\(/, `${rel} must render the button label from the route`);
    assert.match(src, /runCapabilityGapFix\(/, `${rel} must be able to RUN the fix, not just name it`);
  }
  const web = readFileSync(join(repoRoot, "web/components/dashboard/PreviewPane.tsx"), "utf8");
  assert.match(web, /capabilityGapFromDevEvent\(/, "PreviewPane must read the gap off the SSE frame");
  assert.match(web, /capabilityGapFromError\(/, "PreviewPane must read the gap off the /dev/start refusal");
  assert.match(web, /gapFixLabel\(/, "PreviewPane must render the button label from the route");
  assert.match(web, /agentClient\.installTool\(/, "PreviewPane must actually POST the fix");
  assert.match(web, /agentClient\.streamLog\(/, "PreviewPane must STREAM the fix, not fire and forget");
});
