/**
 * compileFailure.test.ts — `npx tsx lib/compileFailure.test.ts`.
 *
 * Pins the web port of the compile-failure card (audit gap D5) plus the
 * phase narration (D6), and pins PARITY with the mobile originals: the two
 * files must carry the same detection shapes, or the "fixed on one of two
 * preview surfaces" drift ships again.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { detectCompileFailure } from "./compileFailure";
import { previewPhaseTitle, previewTimeoutExplanation } from "./previewPhase";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(webRoot, "..");

test("agent's persisted status.error wins and is named", () => {
  const card = detectCompileFailure(
    "The app failed to compile — the dev server is running but has nothing to serve:\nError: No file or variants found for asset: .env.",
    ["noise"],
  );
  assert.ok(card);
  assert.equal(card!.title, "Your app failed to compile");
  assert.match(card!.detail, /No file or variants found for asset/);
});

test("non-compile status.error still surfaces, honestly titled", () => {
  const card = detectCompileFailure("dev server exited before ready", []);
  assert.ok(card);
  assert.equal(card!.title, "The dev server reported a failure");
});

test("log-tail fallback extracts the offending lines", () => {
  const card = detectCompileFailure(null, [
    "Waiting for connection from debug service",
    "lib/main.dart:12:7: Error: The class 'IconData' can't be extended outside of its library.",
    "class MyIcon extends IconData {",
    "Failed to compile application.",
  ]);
  assert.ok(card);
  assert.match(card!.detail, /can't be extended/);
  assert.match(card!.detail, /Failed to compile/);
});

test("clean tail yields no card (no false alarm over a healthy server)", () => {
  assert.equal(detectCompileFailure(null, ["Compiling lib/main.dart...", "✓ built build/web"]), null);
  assert.equal(detectCompileFailure("", []), null);
});

test("phase title narrates the actual phase, not a static 'starting'", () => {
  assert.match(previewPhaseTitle(null, null), /^Starting web dev server/);
  assert.match(previewPhaseTitle({ running: false, framework: "flutter" }, null), /^Starting flutter dev server/);
  assert.match(previewPhaseTitle({ running: true, framework: "flutter" }, null), /server ready/);
  assert.match(previewPhaseTitle({ running: true }, { reason: "flutter_booting" }), /engine booting/);
  assert.match(previewPhaseTitle({ running: true }, { reason: "agent_starting_response" }), /compiling/);
});

test("timeout explanation names a cause per reason", () => {
  assert.match(previewTimeoutExplanation("agent_starting_response"), /never finished compiling/);
  assert.match(previewTimeoutExplanation("empty_body"), /body stayed empty/);
  assert.match(previewTimeoutExplanation(null), /never confirmed a rendered frame/);
});

test("web port carries the same detection shapes as the mobile original", () => {
  const web = readFileSync(join(webRoot, "lib/compileFailure.ts"), "utf8");
  const mobile = readFileSync(join(repoRoot, "mobile/src/lib/compileFailure.ts"), "utf8");
  const regexOf = (src: string) => {
    const m = src.match(/const COMPILE_LINE = (.+);/);
    assert.ok(m, "COMPILE_LINE must exist");
    return m![1];
  };
  assert.equal(regexOf(web), regexOf(mobile), "COMPILE_LINE drifted between web and mobile ports");
});

test("PreviewPane consumes the detector and the phase title", () => {
  const src = readFileSync(join(webRoot, "components/dashboard/PreviewPane.tsx"), "utf8");
  assert.match(src, /detectCompileFailure/);
  assert.match(src, /previewPhaseTitle/);
});
