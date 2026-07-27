// carSessionTurn.test.mts — live-session car dispatch helper.
// Run: npx tsx src/lib/carSessionTurn.test.mts

import test from "node:test";
import assert from "node:assert/strict";

import {
  dispatchSessionTurn,
  parseSpokenChoice,
  summarizeSessionPane,
  type SessionTurnDep,
} from "./carSessionTurn.ts";

test("parseSpokenChoice maps spoken numbers and common yes/no replies", () => {
  assert.equal(parseSpokenChoice("1"), "1");
  assert.equal(parseSpokenChoice("two"), "2");
  assert.equal(parseSpokenChoice("First."), "1");
  assert.equal(parseSpokenChoice("yes"), "1");
  assert.equal(parseSpokenChoice("cancel"), "2");
  assert.equal(parseSpokenChoice("add a test"), null);
});

test("summarizeSessionPane skips code-shaped lines and clamps to a spoken sentence", () => {
  const pane = [
    "const value = runDangerousThing();",
    "Tests passed. Ready for review.",
    "More detail that should not be read.",
  ].join("\n");
  assert.equal(summarizeSessionPane(pane), "Tests passed.");
});

test("dispatchSessionTurn sends a prompt when no choice is pending", async () => {
  const calls: Array<{ text: string | null; choice: string | null }> = [];
  const dep: SessionTurnDep = async (text, choice) => {
    calls.push({ text, choice });
    return {
      ok: true,
      session: "codex",
      awaitingChoice: false,
      pane: "Done. Tests pass.",
    };
  };

  const result = await dispatchSessionTurn("keep going", dep, false);
  assert.deepEqual(calls, [{ text: "keep going", choice: null }]);
  assert.equal(result.spoken, "Done.");
  assert.equal(result.awaitingChoice, false);
});

test("dispatchSessionTurn turns a pending spoken choice into choice payload", async () => {
  const calls: Array<{ text: string | null; choice: string | null }> = [];
  const dep: SessionTurnDep = async (text, choice) => {
    calls.push({ text, choice });
    return {
      ok: true,
      session: "codex",
      awaitingChoice: false,
      pane: "Continuing.",
    };
  };

  const result = await dispatchSessionTurn("yes", dep, true);
  assert.deepEqual(calls, [{ text: null, choice: "1" }]);
  assert.equal(result.spoken, "Continuing.");
});

test("dispatchSessionTurn speaks menu options when the session awaits a choice", async () => {
  const result = await dispatchSessionTurn(
    "keep going",
    async () => ({
      ok: false,
      session: "codex",
      awaitingChoice: true,
      options: ["1. Yes, continue", "2. No, exit"],
      pane: "1. Yes, continue\n2. No, exit",
    }),
    false,
  );
  assert.equal(result.awaitingChoice, true);
  assert.match(result.spoken, /Choose: 1\. Yes, continue\. 2\. No, exit\./);
});

test("dispatchSessionTurn refuses to summarize a prompt the agent could not confirm", async () => {
  // The agent answered `200 {ok:true}` on any `tmux send-keys` exit 0, so a
  // prompt typed into a pane that then did nothing summarized into a cheerful
  // sentence and the user waited on a turn that never started. When the agent
  // says it could not confirm delivery, the spoken line must say so too.
  const result = await dispatchSessionTurn(
    "fix the header",
    async () => ({
      ok: true,
      session: "codex",
      sent: "prompt",
      awaitingChoice: false,
      pane: "$ codex\n> ",
      delivered: "unconfirmed",
      deliveryNote: "The prompt was typed into the session, but the pane did not change afterwards.",
    }),
    false,
  );
  assert.match(result.spoken, /did not change|could not confirm/i);
  assert.equal(result.awaitingChoice, false);
});

test("dispatchSessionTurn summarizes normally when delivery was observed", async () => {
  const result = await dispatchSessionTurn(
    "fix the header",
    async () => ({
      ok: true,
      session: "codex",
      sent: "prompt",
      awaitingChoice: false,
      pane: "Fixed the header.",
      delivered: "observed",
    }),
    false,
  );
  assert.equal(result.spoken, "Fixed the header.");
});
