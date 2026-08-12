// consoleInterleave.test.ts — `npx tsx web/lib/consoleInterleave.test.ts`.
//
// Pins the chat-order interleave of the web task console (2026-08-13 user
// call): user prompts must appear directly above the response segment they
// triggered — NOT all stacked at the top — and must never be dropped while a
// follow-up is still waiting for its response.

import { interleaveConsolePrompts } from "./consoleInterleave";

let failures = 0;
const ok = (cond: boolean, label: string) => {
  if (cond) return;
  failures += 1;
  console.error(`FAIL: ${label}`);
};

{
  // The exact shape from the user's report (task "helo"): two turns, each a
  // banner + response. Prompts must interleave, not stack at top.
  const consoleText = [
    "> build · deepseek-v4-flash",
    "Hello! I'm ready to help. What would you like me to do?",
    "> build · deepseek-v4-flash",
    "Let me find what medici is in this environment.",
  ].join("\n");
  const blocks = interleaveConsolePrompts(consoleText, [
    "helo",
    "i want you to have text to text tests for medici",
  ]);
  const kinds = blocks.map((b) => b.kind);
  ok(JSON.stringify(kinds) === JSON.stringify(["prompt", "console", "prompt", "console"]),
    `chat order prompt→console→prompt→console, got ${JSON.stringify(kinds)}`);
  ok(blocks[0].kind === "prompt" && blocks[0].text === "helo", "prompt[0] is the first user message");
  ok(blocks[1].text.includes("Hello! I'm ready to help"), "response[0] follows prompt[0]");
  ok(blocks[2].text.includes("text to text tests for medici"), "prompt[1] is the second user message");
  ok(blocks[3].text.includes("Let me find what medici is"), "response[1] follows prompt[1]");
}

{
  // Queued follow-up with no response yet: the prompt must still render
  // (2026-08-12 rule — submitted text never vanishes), just after the last
  // response segment.
  const consoleText = [
    "> build · deepseek-v4-flash",
    "First reply.",
  ].join("\n");
  const blocks = interleaveConsolePrompts(consoleText, ["first msg", "second msg (no reply yet)"]);
  const kinds = blocks.map((b) => b.kind);
  ok(JSON.stringify(kinds) === JSON.stringify(["prompt", "console", "prompt"]),
    `queued follow-up kept at the end, got ${JSON.stringify(kinds)}`);
  ok(blocks[2].kind === "prompt" && blocks[2].text.includes("no reply yet"), "queued prompt never dropped");
}

{
  // Extra response segments with no matching prompt (auto-retry / tool-only
  // turns) render after the last prompt — never lost, never paired wrongly.
  const consoleText = [
    "> build · deepseek-v4-flash",
    "Reply one.",
    "> build · deepseek-v4-flash",
    "Reply two.",
    "> build · deepseek-v4-flash",
    "Reply three (extra, no prompt).",
  ].join("\n");
  const blocks = interleaveConsolePrompts(consoleText, ["only prompt"]);
  const kinds = blocks.map((b) => b.kind);
  ok(JSON.stringify(kinds) === JSON.stringify(["prompt", "console", "console", "console"]),
    `extra segments trail after the last prompt, got ${JSON.stringify(kinds)}`);
  ok(blocks[3].text.includes("Reply three"), "extra response segment preserved");
}

{
  // Preamble before the first banner (runner startup noise, or the evicted
  // tail of response 1) renders AFTER the first prompt — the user typed,
  // then the runner started, then the noise. Chronological order.
  const consoleText = [
    "Session is ready, no task given.",
    "> build · deepseek-v4-flash",
    "Hi there!",
  ].join("\n");
  const blocks = interleaveConsolePrompts(consoleText, ["hello"]);
  const kinds = blocks.map((b) => b.kind);
  ok(JSON.stringify(kinds) === JSON.stringify(["prompt", "console", "console"]),
    `prompt first, then preamble, then response, got ${JSON.stringify(kinds)}`);
  ok(blocks[0].kind === "prompt" && blocks[0].text === "hello", "prompt[0] renders before the preamble");
  ok(blocks[1].text.includes("Session is ready"), "preamble preserved");
  ok(blocks[2].text.includes("Hi there"), "banner-led response preserved");
}

{
  // No banner structure (non-opencode runner / no raw lane): fall back to
  // the classic layout — all prompts at top, then the whole console.
  const consoleText = ["some output line", "another line"].join("\n");
  const blocks = interleaveConsolePrompts(consoleText, ["q1", "q2"]);
  const kinds = blocks.map((b) => b.kind);
  ok(JSON.stringify(kinds) === JSON.stringify(["prompt", "prompt", "console"]),
    `no banners → prompts at top, console below, got ${JSON.stringify(kinds)}`);
  ok(blocks[2].text === consoleText, "whole console preserved verbatim");
}

{
  // ANSI-styled banner lines still split (the summarizer keeps escapes so
  // AnsiConsoleText can paint them; the splitter must classify the plain
  // text).
  const consoleText = [
    "\u001b[33m> build · deepseek-v4-flash\u001b[0m",
    "ANSI response.",
  ].join("\n");
  const blocks = interleaveConsolePrompts(consoleText, ["q"]);
  ok(blocks.length === 2 && blocks[1].kind === "console" && blocks[1].text.includes("ANSI response"),
    "ANSI banner still starts a response segment");
}

{
  // Empty prompt list → console only.
  const blocks = interleaveConsolePrompts("> build · deepseek-v4-flash\nreply", []);
  ok(blocks.length === 1 && blocks[0].kind === "console", "no prompts → console only");
  // Empty console + prompts → prompts only.
  const promptsOnly = interleaveConsolePrompts("", ["hello"]);
  ok(promptsOnly.length === 1 && promptsOnly[0].kind === "prompt", "empty console → prompts only");
}

if (failures > 0) {
  console.error(`\n${failures} consoleInterleave test(s) FAILED`);
  process.exit(1);
}
console.log("\nall consoleInterleave tests pass");
