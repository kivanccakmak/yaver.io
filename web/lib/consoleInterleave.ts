// consoleInterleave.ts — pair each user prompt with the console response
// segment it triggered, so the task view reads like a chat.
//
// WHY (2026-08-13, user call): the web task view rendered EVERY user prompt
// as a `$` line at the TOP of the console, then the whole summarized stream
// below — a two-message task read "all my messages, then all replies" instead
// of a conversation. opencode marks the start of each assistant response with
// a `> build · <model>` banner line; the shared console classifier already
// recognizes it (`classifyAnsiLine` → "banner"). This helper splits the
// console at banner lines and interleaves each prompt directly above the
// response segment that follows it — prompt[0] → segment[0] → prompt[1] →
// segment[1] — the same flow the runner's own console shows.
//
// Falls back to the classic all-prompts-at-top layout when the console has no
// banner structure (non-opencode runners whose raw lane lacks per-turn
// banners). Prompts are ALWAYS emitted — a queued follow-up with no response
// yet (segment count < prompt count) still renders, just after the last
// segment (2026-08-12 requirement: submitted text must never vanish).

import { classifyAnsiLine, ansiToPlain } from "./_core/ansi";

export interface ConsoleBlock {
  kind: "prompt" | "console";
  text: string;
}

export function interleaveConsolePrompts(consoleText: string, userPrompts: string[]): ConsoleBlock[] {
  const prompts = (userPrompts || [])
    .map((p) => String(p ?? ""))
    .filter((p) => p.trim().length > 0);
  const blocks: ConsoleBlock[] = [];
  if (!consoleText) {
    for (const p of prompts) blocks.push({ kind: "prompt", text: p });
    return blocks;
  }

  // Split the console at banner lines: every `> build · <model>` line starts
  // a new assistant response segment. Text before the first banner (runner
  // startup noise) is a preamble segment that renders first.
  const segments: string[] = [];
  let current: string[] = [];
  let sawBanner = false;
  for (const line of consoleText.split("\n")) {
    if (classifyAnsiLine(ansiToPlain(line).trim()) === "banner") {
      sawBanner = true;
      if (current.length) segments.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) segments.push(current.join("\n"));

  // No banner structure — classic layout: all prompts at top, console below.
  if (!sawBanner) {
    for (const p of prompts) blocks.push({ kind: "prompt", text: p });
    blocks.push({ kind: "console", text: consoleText });
    return blocks;
  }

  // Text before the first banner is either runner startup noise or — when
  // the tail-keeping summarizer evicted the first banner — the TAIL of the
  // first response. Either way it is chronologically AFTER prompt[0] (the
  // user typed, then the runner started), so prompt[0] renders first, the
  // preamble console block second, and the banner-led segments pair with
  // the remaining prompts.
  const first = segments[0] ?? "";
  const firstStartsBanner = classifyAnsiLine(ansiToPlain(first.split("\n")[0] ?? "").trim()) === "banner";
  let segIdx = 0;
  let promptIdx = 0;
  if (first && !firstStartsBanner) {
    if (prompts.length > 0) {
      blocks.push({ kind: "prompt", text: prompts[0] });
      promptIdx = 1;
    }
    blocks.push({ kind: "console", text: first });
    segIdx = 1;
  }

  // Interleave: prompt[i] pairs with segment[i] (the response it triggered).
  // Extra segments (auto-retry turns, tool-only chatter) render after the
  // last prompt; extra prompts (queued follow-ups still waiting) render
  // after the last segment — never dropped.
  const count = Math.max(prompts.length - promptIdx, segments.length - segIdx);
  for (let i = 0; i < count; i++) {
    if (promptIdx + i < prompts.length) blocks.push({ kind: "prompt", text: prompts[promptIdx + i] });
    const seg = segments[segIdx + i];
    if (seg) blocks.push({ kind: "console", text: seg });
  }
  return blocks;
}
