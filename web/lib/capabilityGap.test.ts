/**
 * capabilityGap.test.ts — `npx tsx lib/capabilityGap.test.ts`.
 *
 * Web side of the named-capability-gap layer. The deep parity + Go wire-contract
 * checks live in mobile/src/lib/capabilityGap.test.mts; this pins that the WEB
 * module itself behaves (importing the mobile twin there would prove nothing
 * about what a browser bundle loads) and that the web consumers are real.
 *
 * Before this layer, web had no install affordance anywhere: agent-client.ts
 * parsed the typed 412 fields and immediately folded them back into a string no
 * view branched on, so a missing toolchain read as one grey log line.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  capabilityGapFromError,
  gapFixLabel,
  gapInstallTool,
  gapStreamPath,
  gapTitle,
  parseCapabilityGap,
} from "./capabilityGap";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const FLUTTER_GAP = {
  code: "capability.toolchain_missing",
  capability: "flutter",
  summary: "Flutter isn't installed on this machine.",
  detail: "Yaver can install it here, no sudo needed.",
  fix: { label: "Install Flutter", method: "POST", path: "/install/flutter", stream: "install:flutter", est: "~1.2 GB SDK · usually 3–10 min", retry: true },
};

test("a 412 refusal becomes a sentence plus a tappable route", () => {
  const err: any = new Error("Flutter isn't installed on this machine.");
  err.capabilityGap = FLUTTER_GAP;
  const gap = capabilityGapFromError(err);
  assert.ok(gap);
  assert.equal(gapTitle(gap!), "Flutter isn't installed on this machine.");
  assert.match(gapFixLabel(gap!)!, /^Install Flutter/);
  assert.equal(gapInstallTool(gap!), "flutter");
  assert.equal(gapStreamPath(gap!), "/streams/install:flutter");
});

test("no route ⇒ no button, ever", () => {
  const gap = parseCapabilityGap({
    code: "capability.toolchain_missing",
    capability: "wda",
    summary: "wda isn't installed on this machine.",
    constraint: "Yaver has no install recipe for wda on this machine.",
  });
  assert.ok(gap);
  assert.equal(gapFixLabel(gap!), null);
  assert.equal(gapStreamPath(gap!), null);
});

test("agent-client forwards the typed gap instead of flattening it", () => {
  const src = readFileSync(join(webRoot, "lib/agent-client.ts"), "utf8");
  assert.match(src, /err\.capabilityGap = data\?\.capabilityGap/, "the 412 gap is dropped again — web loses its Install button");
  assert.match(src, /capabilityGap\?: unknown/, "getDevServerStatus must pass the polled gap through");
});

test("both web preview surfaces render the route", () => {
  for (const rel of ["components/dashboard/PreviewPane.tsx", "components/dashboard/RuntimeLabView.tsx"]) {
    const src = readFileSync(join(webRoot, rel), "utf8");
    assert.match(src, /from "@\/lib\/capabilityGap"/, `${rel} must import the renderer`);
    assert.match(src, /capabilityGapFromDevEvent\(/, `${rel} must read the gap off the SSE frame`);
    assert.match(src, /gapFixLabel\(/, `${rel} must render the button label from the route`);
    assert.match(src, /agentClient\.installTool\(/, `${rel} must actually POST the fix`);
    assert.match(src, /agentClient\.streamLog\(/, `${rel} must STREAM the fix, not fire and forget`);
  }
});
