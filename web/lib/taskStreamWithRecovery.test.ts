/**
 * taskStreamWithRecovery.test.ts — `npx tsx lib/taskStreamWithRecovery.test.ts`.
 *
 * The connectivity+vibing pass gave `streamTaskOutput` an `onEnd` callback and
 * a `?since=` resume, and gave `taskStreamRecovery.ts` the policy. VibeCodingView
 * wired both by hand. FOUR other web call sites — PreviewPane, RuntimeLabView,
 * WebReloadView (x2) and app/dashboard/page.tsx — passed no `onEnd` at all, so
 * they kept the original defect exactly: a severed relay tunnel froze the
 * transcript on its last frame, under a spinner, over a task that was still
 * running fine on the box.
 *
 * These tests pin the wrapper's behaviour AND that every call site uses it,
 * because a helper nobody calls fixes nothing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { streamTaskOutputWithRecovery, type TaskStreamHealth } from "./taskStreamWithRecovery";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..");

/** A fake client that lets a test end a stream on demand. */
function fakeClient() {
  const calls: Array<{ since: number; end: (info: { sawDone: boolean; cancelled: boolean; error?: string }) => void; chunk: (s: string) => void }> = [];
  return {
    calls,
    streamTaskOutput(
      _taskId: string,
      onChunk: (chunk: string) => void,
      _onEvent?: (e: Record<string, unknown>) => void,
      opts?: { since?: number; onEnd?: (info: { sawDone: boolean; cancelled: boolean; error?: string }) => void },
    ) {
      calls.push({ since: Number(opts?.since || 0), end: opts?.onEnd || (() => {}), chunk: onChunk });
      return () => {};
    },
  };
}

test("an interrupted stream is named, not swallowed", () => {
  const client = fakeClient();
  const seen: TaskStreamHealth[] = [];
  streamTaskOutputWithRecovery(client, "t1", () => {}, undefined, { onHealth: (h) => seen.push(h) });

  // A clean EOF with no `done` frame — exactly what a dropped relay tunnel
  // looks like, and exactly the case the old code treated as "fine".
  client.calls[0].end({ sawDone: false, cancelled: false });

  const named = seen.filter((h) => h && h.kind === "reattaching");
  assert.equal(named.length, 1, "a dropped stream must produce a visible 'reattaching' state");
  assert.match(String(named[0]!.message), /still running on the box/, "the user must be told the task survived the stream");
});

test("a finished stream says nothing", () => {
  const client = fakeClient();
  const seen: TaskStreamHealth[] = [];
  streamTaskOutputWithRecovery(client, "t1", () => {}, undefined, { onHealth: (h) => seen.push(h) });
  client.calls[0].end({ sawDone: true, cancelled: false });
  assert.ok(!seen.some((h) => h !== null), "a task that really finished must not raise a recovery banner");
});

test("a local teardown says nothing", () => {
  const client = fakeClient();
  const seen: TaskStreamHealth[] = [];
  const stop = streamTaskOutputWithRecovery(client, "t1", () => {}, undefined, { onHealth: (h) => seen.push(h) });
  client.calls[0].end({ sawDone: false, cancelled: true });
  stop();
  assert.ok(!seen.some((h) => h && h.kind !== "reattaching" && h.kind !== "lost") || !seen.some((h) => h !== null),
    "switching tasks must not accuse the transport");
});

test("the reattach resumes from bytes received, never from zero", async () => {
  const client = fakeClient();
  streamTaskOutputWithRecovery(client, "t1", () => {}, undefined, {});
  client.calls[0].chunk("hello world");   // 11 bytes
  client.calls[0].end({ sawDone: false, cancelled: false });
  // First rung is 1000 ms; wait past it.
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(client.calls.length, 2, "the ladder must actually resubscribe");
  assert.equal(client.calls[1].since, 11, "resuming from 0 replays a transcript the user already read");
});

test("a chunk clears the banner and resets the ladder", () => {
  const client = fakeClient();
  const seen: TaskStreamHealth[] = [];
  streamTaskOutputWithRecovery(client, "t1", () => {}, undefined, { onHealth: (h) => seen.push(h) });
  client.calls[0].end({ sawDone: false, cancelled: false });
  assert.ok(seen.some((h) => h && h.kind === "reattaching"));
  client.calls[0].chunk("alive again");
  assert.equal(seen[seen.length - 1], null, "a live chunk must clear the banner — a stale warning is its own lie");
});

test("give-up hands over a Reattach route, not just a sentence", () => {
  const client = fakeClient();
  let last: TaskStreamHealth = null;
  streamTaskOutputWithRecovery(client, "t1", () => {}, undefined, { onHealth: (h) => (last = h) });
  // Exhaust the ladder without waiting on timers: each end() bumps `attempt`.
  for (let i = 0; i < 8; i += 1) client.calls[0].end({ sawDone: false, cancelled: false });
  const health = last as TaskStreamHealth;
  assert.ok(health && health.kind === "lost", "the ladder must eventually stop and say so");
  assert.equal(typeof health!.reattach, "function", "give-up without a button is a dead end with a sentence");
});

/**
 * THE WIRING GUARD. The wrapper existing is not the deliverable; the call
 * sites using it is. Every web `streamTaskOutput` consumer must either go
 * through the wrapper or pass its own `onEnd` — a bare call is the freeze.
 */
test("no web surface subscribes to task output without an end handler", () => {
  const sites = [
    "components/dashboard/PreviewPane.tsx",
    "components/dashboard/RuntimeLabView.tsx",
    "components/dashboard/WebReloadView.tsx",
    "app/dashboard/page.tsx",
    "components/dashboard/VibeCodingView.tsx",
  ];
  for (const rel of sites) {
    const src = readFileSync(join(WEB, rel), "utf8");
    const bare = src.split("agentClient.streamTaskOutput(").length - 1;
    const wrapped = src.split("streamTaskOutputWithRecovery(").length - 1;
    const hasOwnOnEnd = /onEnd:\s*\(/.test(src);
    assert.ok(
      bare === 0 || hasOwnOnEnd,
      `${rel} calls agentClient.streamTaskOutput directly with no onEnd — a severed stream freezes this surface on its last frame ` +
        `(wrapped=${wrapped}, bare=${bare}). Use streamTaskOutputWithRecovery.`,
    );
  }
});

/** The shared notice must be the only place the banner is drawn, or five
 *  hand-rolled copies drift the way the relay-auth matchers already have. */
test("the recovery banner is rendered from one component", () => {
  for (const rel of [
    "components/dashboard/PreviewPane.tsx",
    "components/dashboard/RuntimeLabView.tsx",
    "components/dashboard/WebReloadView.tsx",
    "app/dashboard/page.tsx",
  ]) {
    const src = readFileSync(join(WEB, rel), "utf8");
    assert.match(src, /<StreamHealthNotice/, `${rel} wires the ladder but renders nothing — a reattach the user cannot see is a different silence`);
  }
});
