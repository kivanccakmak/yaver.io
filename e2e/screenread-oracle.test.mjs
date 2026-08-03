/**
 * screenread-oracle.test.mjs — the text oracle must READ, not merely run.
 *
 *   node e2e/screenread-oracle.test.mjs
 *
 * L0 guard for docs/architecture/APPLE_VISION_TEXT_ORACLE.md. The oracle is what
 * lets surfaces WITHOUT a DOM — tvOS, visionOS, watch, car, a WebRTC frame —
 * reach a NAMED verdict instead of only PIXELS or SILENT.
 *
 * 🔴 It attempts a RUN, never os.Stat. A present-but-killable binary is the
 * canonical "inventory says yes, operation says no", and on macOS an unsigned
 * helper is KILLED under launchd while launchd still reports "spawn scheduled" —
 * it looks like a hang, not a rejection. That took this repo's agent down for a
 * session on 2026-07-25.
 *
 * SKIPS on non-macOS and when the helper is absent: the oracle is opportunistic
 * by design and must never be load-bearing (§4, the Linux non-regression
 * contract). A skip here is correct; a failure would make Linux CI red for a
 * capability Linux is not supposed to have.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(repo, "desktop/agent/screenread/screenread");
const fixture = join(repo, "scripts/screenshots/output-tvos/01_yaver_tv_signin.png");

const runnable = process.platform === "darwin" && existsSync(helper) && existsSync(fixture);

test("the oracle reads a tvOS frame it has never been told about", { skip: !runnable && "macOS + built helper only" }, () => {
  const out = JSON.parse(execFileSync(helper, [fixture], { encoding: "utf8", timeout: 30_000 }));
  assert.equal(out.ok, true, `oracle failed: ${out.error}`);
  assert.ok(out.blocks.length >= 3, `expected several text blocks, got ${out.blocks.length}`);

  const text = out.blocks.map((b) => b.text).join(" ");
  // The exact sentence a user sees on the TV sign-in screen. If the screen is
  // redesigned this fails LOUDLY, which is correct: the oracle's value is that
  // it reads what is actually rendered.
  assert.match(text, /Sign in to Yaver/i, "did not read the sign-in heading");

  // THE NEW CAPABILITY: the device code is machine-readable, so tvOS headless
  // auth needs no human. Shape, not the literal code — fixtures rotate.
  assert.match(text, /\b[A-Z0-9]{4}-\d{4}\b/, "no device code recovered from the frame");

  // Boxes must be usable for targeting, not just present.
  for (const b of out.blocks) {
    assert.ok(b.w > 0 && b.h > 0, `degenerate bounding box: ${JSON.stringify(b)}`);
    assert.ok(b.x >= 0 && b.x <= 1 && b.y >= 0 && b.y <= 1, `box outside 0..1: ${JSON.stringify(b)}`);
  }
});

test("a missing frame fails LOUDLY and names the path", { skip: !runnable && "macOS + built helper only" }, () => {
  let raw = "";
  try {
    execFileSync(helper, [join(repo, "does-not-exist.png")], { encoding: "utf8" });
    assert.fail("a missing frame must exit non-zero, not report success");
  } catch (err) {
    raw = err.stdout || "";
  }
  const out = JSON.parse(raw);
  assert.equal(out.ok, false);
  assert.match(out.error, /does-not-exist\.png/,
    "the error must name the path — the commonest cause is a screenshot never written " +
    "(a simulator that did not boot), and a bare 'decode failed' sends the reader after the wrong bug");
});
