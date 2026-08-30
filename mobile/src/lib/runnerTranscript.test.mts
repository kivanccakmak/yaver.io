import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAssistantPreview,
  buildLiveAssistantMarkdown,
  groomRunnerTranscript,
} from "./runnerTranscript.ts";

const incident = [
  'codex İsteği kısa tutuyorum; bir terminal komutuyla yanıt veriyorum. exec /bin/bash -lc "printf \'hello\\n\'" in /root succeeded in 0ms: hello',
  "",
  "codex Outcome: terminal output produced.",
  "",
  "hello",
  "Outcome: terminal output produced.",
  "",
  "hello",
  "tokens used 8,053 codexOutcome: terminal output produced.texthelloOutcome: terminal output produced.texthellotokens used8,053",
].join("\n");

test("groomRunnerTranscript removes raw protocol furniture", () => {
  const { body, tokensUsed } = groomRunnerTranscript(incident);
  assert.equal(tokensUsed, "8,053");
  assert.match(body, /\*\*\$ \/bin\/bash -lc "printf 'hello\\n'"\*\*/);
  assert.doesNotMatch(body, /Outcome:/);
  assert.doesNotMatch(body, /texthello/);
  assert.match(body, /İsteği kısa tutuyorum/);
});

test("buildAssistantPreview returns a human summary, not runner framing", () => {
  const preview = buildAssistantPreview(incident);
  assert.equal(preview.summary, "İsteği kısa tutuyorum; bir terminal komutuyla yanıt veriyorum.");
  assert.ok(preview.cleaned.includes('**$ /bin/bash -lc "printf \'hello\\n\'"**'));
  assert.ok(preview.activity.includes(`$ /bin/bash -lc "printf 'hello\\n'"`));
});

test("buildLiveAssistantMarkdown keeps readable progress and hides tool noise", () => {
  const live = buildLiveAssistantMarkdown([
    "workdir: /root",
    "model: gpt-5-codex",
    "**$ rg -n \"task\" .**",
    "Found the task renderer.",
    "Updated the formatter path.",
  ].join("\n"));
  assert.match(live, /Found the task renderer\./);
  assert.match(live, /Updated the formatter path\./);
  assert.match(live, /\$ rg -n "task" \./);
  assert.doesNotMatch(live, /^workdir:/m);
  assert.doesNotMatch(live, /^model:/m);
});
