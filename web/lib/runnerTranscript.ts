/**
 * runnerTranscript.ts — client-side grooming of raw runner protocol output
 * into chat-grade content.
 *
 * Motivating paste (2026-07-27, dashboard Chat tab, codex exec-mode, "helo"):
 *
 *   codex İsteği kısa tutuyorum… exec /bin/bash -lc "printf 'hello\n'" in
 *   /root succeeded in 0ms: hello
 *   codex Outcome: terminal output produced.
 *   hello
 *   Outcome: terminal output produced.
 *   hello
 *   tokens used 8,053 codexOutcome: terminal output produced.texthello…
 *
 * The DATA is fine — the agent stores exactly what codex emitted, and the
 * console surfaces should keep showing it verbatim. What was wrong is that the
 * CHAT surfaces rendered the protocol stream as if it were the assistant's
 * message. The codex and Claude Code TUIs draw the same stream as framed tool
 * cards with a token-count status row; this module is that presentation layer:
 *
 *   - `exec <cmd> in <dir> <verdict> in <t>: <out>` → the `**$ <cmd>**` shell
 *     pill + fenced output, the SAME vocabulary readStreamJSON emits for
 *     claude and opencodeStreamFilter emits for opencode, so all three
 *     runners scan identically in a transcript.
 *   - `Outcome: terminal output produced.` → dropped (pure protocol framing).
 *   - `tokens used N` → extracted into `tokensUsed` for the caller to render
 *     as a footer chip on its own line, never inline prose.
 *   - runner-tag prefixes (`codex `) on lines → dropped.
 *   - the trailing flattened echo (the whole reply re-serialized as one line,
 *     with JSON keys like `text` glued to their values) → dropped when it
 *     contains nothing that wasn't already said.
 *
 * Grooming is idempotent and line-based, so it is safe on live streaming
 * chunks as well as finalized turns.
 */

export interface GroomedTranscript {
  body: string;
  /** Last "tokens used" figure seen (e.g. "17,057"); null when absent. */
  tokensUsed: string | null;
}

const OUTCOME_RE = /(?:codex\s*)?Outcome:\s*terminal output produced\.?/g;
const TOKENS_RE = /(?:codex\s*)?tokens used[:\s]*([\d][\d.,]*)/gi;
const EXEC_RE = /^(?:codex\s+)?(.*?)\bexec\s+(.+?)\s+in\s+(\S+)\s+(succeeded|failed|exited(?:\s+\S+)?)\s+in\s+([\d.]+m?s):?\s*(.*)$/;

function normalize(s: string): string {
  // `text` is removed because the flattened-echo artifact glues the JSON key
  // `text` to its value ("texthello"); it never survives as signal here.
  return s.toLowerCase().replace(/text/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
}

/** True when `candidate` says nothing that `earlier` hasn't already said —
 *  i.e. removing every earlier fragment from it repeatedly leaves nothing. */
function isEchoOfEarlier(candidate: string, earlier: string[]): boolean {
  let residue = normalize(candidate);
  if (residue.length < 8) return false;
  const fragments = earlier.map(normalize).filter((f) => f.length >= 4);
  if (!fragments.length) return false;
  let changed = true;
  while (changed && residue.length > 0) {
    changed = false;
    for (const fragment of fragments) {
      if (fragment && residue.includes(fragment)) {
        residue = residue.split(fragment).join("");
        changed = true;
      }
    }
  }
  return residue.length === 0;
}

export function groomRunnerTranscript(raw: string): GroomedTranscript {
  let tokensUsed: string | null = null;
  let text = String(raw || "");

  text = text.replace(TOKENS_RE, (_all, figure: string) => {
    tokensUsed = figure;
    return " ";
  });
  text = text.replace(OUTCOME_RE, " ");

  const outLines: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trimEnd();
    const exec = EXEC_RE.exec(line.trim());
    if (exec) {
      const [, lead, cmd, , verdict, elapsed, tail] = exec;
      const leadText = lead.replace(/^codex\s+/, "").trim();
      if (leadText) outLines.push(leadText, "");
      outLines.push(`**$ ${cmd}** _(${verdict} in ${elapsed})_`);
      if (tail.trim()) outLines.push("```", tail.trim(), "```");
      continue;
    }
    line = line.replace(/^\s*codex\s+/, "").trimEnd();
    if (!line.trim() && outLines[outLines.length - 1] === "") continue;
    if (line.trim() === "codex") continue;
    outLines.push(line);
  }

  // Drop trailing paragraphs that only re-say what the transcript already
  // said (the flattened-echo artifact, and codex re-printing its final answer
  // after the stream already showed it). Also collapse exact duplicates.
  const paragraphs = outLines
    .join("\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const kept: string[] = [];
  const seen = new Set<string>();
  for (let paragraph of paragraphs) {
    // codex re-prints its final answer after the stream already carried it,
    // and token-extraction can fuse the two copies into ONE paragraph
    // ("Hello again! … Hello again! …"). Collapse exact self-echo.
    for (let guard = 0; guard < 4; guard++) {
      const collapsed = paragraph.replace(/^([\s\S]{8,}?)\s+\1$/u, "$1");
      if (collapsed === paragraph) break;
      paragraph = collapsed;
    }
    const norm = normalize(paragraph);
    if (norm && seen.has(norm)) continue;
    if (kept.length && isEchoOfEarlier(paragraph, kept)) continue;
    if (norm) seen.add(norm);
    kept.push(paragraph);
  }

  return { body: kept.join("\n\n").trim(), tokensUsed };
}
