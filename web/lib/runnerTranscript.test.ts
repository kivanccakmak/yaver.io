/**
 * runnerTranscript.test.ts — `npx tsx lib/runnerTranscript.test.ts` from web/.
 * Plain node, same tiny assert harness as the other web lib tests.
 *
 * The fixture is the REAL paste from the 2026-07-27 incident: "helo" answered
 * by codex exec-mode, rendered raw in the Chat tab. If grooming regresses,
 * these fail with the exact protocol furniture users complained about.
 */
import { groomRunnerTranscript } from "./runnerTranscript";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

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

{
  const { body, tokensUsed } = groomRunnerTranscript(incident);
  check("tokens extracted to metadata", tokensUsed === "8,053", `got ${tokensUsed}`);
  check("tokens never inline", !/tokens used/i.test(body), body);
  check("outcome framing dropped", !/Outcome:/.test(body), body);
  check("exec becomes shell pill", body.includes('**$ /bin/bash -lc "printf \'hello\\n\'"**'), body);
  check("runner tag stripped", !/^codex\b/m.test(body), body);
  check(
    "answer said once, not four times",
    (body.match(/^hello$/gm) || []).length <= 2, // fenced output + one prose echo at most
    body,
  );
  check("flattened echo tail dropped", !/texthello/.test(body), body);
  check("the human-facing preamble survives", body.includes("İsteği kısa tutuyorum"), body);
}

{
  const followUp = "codex Hello again! Ready when you are. tokens used 17,057 Hello again! Ready when you are.";
  const { body, tokensUsed } = groomRunnerTranscript(followUp);
  check("follow-up tokens extracted", tokensUsed === "17,057", `got ${tokensUsed}`);
  check(
    "final answer deduped",
    (body.match(/Hello again!/g) || []).length === 1,
    body,
  );
}

{
  // Plain prose from any runner must pass through untouched.
  const prose = "Here is the plan:\n\n- fix the poll\n- cap the payload\n\nDone.";
  const { body, tokensUsed } = groomRunnerTranscript(prose);
  check("plain prose untouched", body === prose, body);
  check("no phantom tokens", tokensUsed === null, String(tokensUsed));
}

{
  // Legitimate repetition ("ok\n\nok") is short — must NOT be deduped into
  // silence... but identical paragraphs collapse by design. Assert the first
  // survives.
  const { body } = groomRunnerTranscript("ok\n\nok");
  check("duplicate paragraph keeps first occurrence", body === "ok", body);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall good");
