/**
 * taskStreamRecovery.test.ts — `npx tsx lib/taskStreamRecovery.test.ts`.
 *
 * Pins the fix for the connectivity+vibing P0: a task-output stream that drops
 * mid-render used to freeze the surface in silence on BOTH mobile and web.
 * These tests pin (1) that a stream which ends without a `done` frame is
 * classified as an INTERRUPTION even when the platform reports no error —
 * the exact case that shipped the freeze; (2) that the user is told the task
 * is still running; (3) that both transports actually report the end instead
 * of swallowing it; (4) that the agent's resume contract exists; and
 * (5) web/mobile twin parity.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_REATTACH_ATTEMPTS,
  classifyStreamEnd,
  planStreamRecovery,
  reattachDelayMs,
} from "./taskStreamRecovery";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(webRoot, "..");

test("a stream that ends with no done frame and NO error is an interruption", () => {
  // This is the case that shipped the freeze: a relay tunnel that closes
  // cleanly looks like a well-behaved EOF. Reading "no error" as "fine" is
  // precisely how both surfaces concluded there was nothing to report.
  assert.equal(classifyStreamEnd({ sawDone: false, cancelled: false }), "interrupted");
  assert.equal(
    classifyStreamEnd({ sawDone: false, cancelled: false, error: "network error" }),
    "interrupted",
  );
});

test("done and local cancel are NOT interruptions", () => {
  assert.equal(classifyStreamEnd({ sawDone: true, cancelled: false }), "done");
  assert.equal(classifyStreamEnd({ sawDone: false, cancelled: true }), "cancelled");
  // A done frame wins over a subsequent teardown — the task really finished.
  assert.equal(classifyStreamEnd({ sawDone: true, cancelled: true }), "done");
});

test("only an interruption schedules a reattach", () => {
  for (const end of ["done", "cancelled"] as const) {
    assert.equal(planStreamRecovery({ end, attempt: 0 }).action, "idle");
  }
});

test("reattach narrates progress, the cause, and that the task survives", () => {
  const plan = planStreamRecovery({
    end: "interrupted",
    attempt: 1,
    cause: "device not connected to relay",
  });
  assert.equal(plan.action, "reattach");
  if (plan.action !== "reattach") return;
  assert.match(plan.message, /reattaching \(2 of 5\)/i, "must count attempts for the user");
  assert.match(plan.message, /still running on the box/i, "must say the task survived the drop");
  assert.match(plan.message, /device not connected to relay/, "must preserve the cause");
  assert.equal(plan.delayMs, reattachDelayMs(1));
});

test("give-up names the route back and never blames the task", () => {
  const plan = planStreamRecovery({
    end: "interrupted",
    attempt: MAX_REATTACH_ATTEMPTS,
    cause: "relay 502",
  });
  assert.equal(plan.action, "give-up");
  if (plan.action !== "give-up") return;
  assert.match(plan.message, /still running on the box/i);
  assert.match(plan.message, /Reattach/, "give-up must offer a route, not just a verdict");
  assert.match(plan.message, /Reconnect/);
  assert.match(plan.message, /relay 502/);
});

test("backoff is bounded and monotonic", () => {
  const delays = [0, 1, 2, 3, 4, 5, 99].map(reattachDelayMs);
  for (let i = 1; i < delays.length; i++) {
    assert.ok(delays[i] >= delays[i - 1], "backoff must never shrink");
  }
  assert.equal(delays[delays.length - 1], 15000, "backoff must cap");
  assert.ok(delays[0] <= 1000, "first reattach must be fast — a relay bounce heals in seconds");
});

test("BOTH transports report stream end instead of swallowing it", () => {
  // The regression this guards: `xhr.onerror = () => {}` on mobile and
  // `catch {}` on web. If either transport stops reporting the end, the
  // policy above can never run and the freeze silently returns.
  const mobileSrc = readFileSync(join(repoRoot, "mobile/src/lib/quic.ts"), "utf8");
  const webSrc = readFileSync(join(repoRoot, "web/lib/agent-client.ts"), "utf8");
  for (const [name, src] of [
    ["mobile/src/lib/quic.ts", mobileSrc],
    ["web/lib/agent-client.ts", webSrc],
  ] as const) {
    assert.match(
      src,
      /reportStreamEnd/,
      `${name}: streamTaskOutput must report how the stream ended`,
    );
    assert.match(
      src,
      /since=/,
      `${name}: streamTaskOutput must be able to resume from a byte offset`,
    );
  }
});

test("the agent's resume contract exists and is documented", () => {
  // Client-side reattach is only lossless because the agent honors ?since=.
  // If that goes away, reattaching starts duplicating transcripts again.
  const agentSrc = readFileSync(join(repoRoot, "desktop/agent/httpserver.go"), "utf8");
  assert.match(agentSrc, /resumeRequested/, "agent lost the ?since= resume support");
  assert.match(agentSrc, /"type":\s*"resume"|"resume"/, "agent must emit a resume frame");
});

test("web/mobile twins are byte-identical below the header comment", () => {
  const strip = (src: string) =>
    src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n")
      .trim();
  const web = strip(readFileSync(join(webRoot, "lib/taskStreamRecovery.ts"), "utf8"));
  const mobile = strip(readFileSync(join(repoRoot, "mobile/src/lib/taskStreamRecovery.ts"), "utf8"));
  assert.equal(
    web,
    mobile,
    "taskStreamRecovery twins drifted — sync web/lib/ and mobile/src/lib/",
  );
});
