import test from "node:test";
import assert from "node:assert/strict";

import { createRunnerChannel } from "./runnerChannel.ts";

test("session picker replays the original instruction against the chosen session", async () => {
  const calls: Array<{ text: string | null; choice: string | null; session?: string }> = [];
  const channel = createRunnerChannel({
    sessionTurn: async (text, choice, session) => {
      calls.push({ text, choice, session });
      if (!session) {
        return {
          ok: false,
          session: "",
          awaitingChoice: false,
          needsChoice: true,
          available: [
            { name: "runner-one", runner: "claude", index: 0 },
            { name: "runner-two", runner: "codex", index: 1 },
          ],
          error: "several runner sessions are live",
        };
      }
      return {
        ok: true,
        session,
        awaitingChoice: false,
        pane: "Continuing the audit.",
      };
    },
  });

  const first = await channel.send("keep working on the audit", {
    pendingChoice: false,
    surface: "car",
  });
  assert.equal(first.awaitingChoice, true);
  assert.match(first.spoken, /Several sessions/);

  const second = await channel.send("two", {
    pendingChoice: true,
    surface: "car",
  });
  assert.equal(second.awaitingChoice, false);
  assert.equal(second.spoken, "Continuing the audit.");
  assert.deepEqual(calls, [
    { text: "keep working on the audit", choice: null, session: undefined },
    { text: "keep working on the audit", choice: null, session: "runner-two" },
  ]);
});

test("invalid session picker answer never reaches tmux", async () => {
  let calls = 0;
  const channel = createRunnerChannel({
    sessionTurn: async () => {
      calls++;
      return {
        ok: false,
        session: "",
        awaitingChoice: false,
        available: [
          { name: "one", runner: "claude", index: 0 },
          { name: "two", runner: "codex", index: 1 },
        ],
      };
    },
  });
  await channel.send("continue", { pendingChoice: false, surface: "phone" });
  const retry = await channel.send("the blue one", { pendingChoice: true, surface: "phone" });
  assert.equal(calls, 1);
  assert.equal(retry.awaitingChoice, true);
  assert.match(retry.spoken, /session number/);
});
