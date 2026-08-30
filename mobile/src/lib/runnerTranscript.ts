import { sliceAfterFrameBoundary } from "./promptFraming";
import { stripAnsi, stripMarkdownForPreview } from "./taskPreview";

export interface GroomedTranscript {
  body: string;
  tokensUsed: string | null;
}

export interface AssistantPreview {
  summary: string;
  cleaned: string;
  activity: string[];
  shouldCollapse: boolean;
  hasHiddenNoise: boolean;
}

const OUTCOME_RE = /(?:codex\s*)?Outcome:\s*terminal output produced\.?/g;
const TOKENS_RE = /(?:codex\s*)?tokens used[:\s]*([\d][\d.,]*)/gi;
const EXEC_RE = /^(?:codex\s+)?(.*?)\bexec\s+(.+?)\s+in\s+(\S+)\s+(succeeded|failed|exited(?:\s+\S+)?)\s+in\s+([\d.]+m?s):?\s*(.*)$/;

function normalize(s: string): string {
  return s.toLowerCase().replace(/text/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizePreviewLine(line: string): string {
  return stripMarkdownForPreview(line)
    .replace(/^\s*[-*]\s+/, "")
    .replace(/^\s*\d+\.\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

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

function dedupeOpencodeEchoes(s: string): string {
  const fenceContents: Set<string>[] = [];
  const fenceRE = /```[^\n]*\n([\s\S]*?)\n```/g;
  let fm: RegExpExecArray | null;
  while ((fm = fenceRE.exec(s)) !== null) {
    const set = new Set<string>();
    for (const line of fm[1].split("\n")) {
      const t = line.trim();
      if (t) set.add(t);
    }
    if (set.size > 0) fenceContents.push(set);
  }
  if (fenceContents.length === 0) return s;

  const markerRE = /\n\*\*\$\s+[^\n]+\*\*\n/g;
  let result = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = markerRE.exec(s)) !== null) {
    const markerEnd = m.index + m[0].length;
    result += s.slice(last, markerEnd);
    last = markerEnd;

    const rest = s.slice(last);
    let end = rest.length;
    const blank = rest.indexOf("\n\n");
    if (blank >= 0 && blank < end) end = blank;
    const fenceStart = rest.indexOf("\n```");
    if (fenceStart >= 0 && fenceStart < end) end = fenceStart;
    if (end <= 0) continue;

    const rowLines = rest
      .slice(0, end)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (rowLines.length < 3) continue;

    const threshold = Math.max(3, Math.floor((rowLines.length * 7) / 10));
    let dropped = false;
    for (const fence of fenceContents) {
      let hit = 0;
      for (const row of rowLines) {
        if (fence.has(row)) hit++;
      }
      if (hit >= threshold) {
        dropped = true;
        break;
      }
    }
    if (dropped) {
      last += end;
    }
  }
  result += s.slice(last);
  return result;
}

function dedupeCodexEchoes(s: string): string {
  s = s.replace(
    /\n?exec\n([^\n]+?)(?:\s+in\s+[^\n]+)?\n\s*succeeded in [\d.]+\s*m?s:\n[\s\S]*?(?=\n\n|\ncodex\n|$)/g,
    (_match, cmd: string) => `\n**$ ${String(cmd).trim()}**\n`,
  );
  s = s.replace(/(^|\n)codex\n/g, "$1");
  s = s.replace(/(```[^\n]*\n[\s\S]*?\n```)\s*\n+\1/g, "$1");
  s = s.replace(/([^\n]+:\s*\n+```[^\n]*\n[\s\S]*?\n```)\s*\n+\1/g, "$1");
  return s;
}

function dedupeRepeatedAssistantResponse(s: string): string {
  let out = s.trim();
  for (let pass = 0; pass < 2; pass++) {
    const lines = out.replace(/\r/g, "").split("\n");
    const firstIndex = lines.findIndex((line) => stripAnsi(line).trim().length > 0);
    if (firstIndex < 0) return out;
    const firstLine = stripAnsi(lines[firstIndex]).trim();
    let collapsed = false;
    let candidates = 0;
    for (let i = firstIndex + 1; i < lines.length && candidates < 8; i++) {
      if (stripAnsi(lines[i]).trim() !== firstLine) continue;
      candidates += 1;
      const left = lines.slice(firstIndex, i).join("\n").trim();
      const right = lines.slice(i).join("\n").trim();
      const normalizeText = (value: string) => stripAnsi(value)
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (left.length >= 24 && normalizeText(left) === normalizeText(right)) {
        out = left;
        collapsed = true;
        break;
      }
    }
    if (!collapsed) break;
  }
  return out;
}

export function stripPromptEcho(content: string): string {
  if (!content) return content;
  let out = sliceAfterFrameBoundary(stripAnsi(content));
  out = out.replace(/^[\s\S]*?OpenAI Codex v[^\n]*\n(?:[\s\S]*?\n)?\s*\n/, "");
  out = out.replace(/^Reading additional input from stdin[.…]*\s*\n?/, "");
  out = out.replace(/\n*\s*tokens used\s*\n?\s*[\d,]+\s*/gi, "\n\n");
  out = dedupeCodexEchoes(out);
  out = dedupeOpencodeEchoes(out);
  out = dedupeRepeatedAssistantResponse(out);
  return out.trim();
}

export function groomRunnerTranscript(raw: string): GroomedTranscript {
  let tokensUsed: string | null = null;
  const source = String(raw || "");
  for (const match of source.matchAll(new RegExp(TOKENS_RE.source, TOKENS_RE.flags))) {
    tokensUsed = match[1];
  }
  let text = stripPromptEcho(source);

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

  const paragraphs = outLines
    .join("\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const kept: string[] = [];
  const seen = new Set<string>();
  for (let paragraph of paragraphs) {
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

export function extractAssistantActivity(text: string, maxItems = 4): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const rawLine of lines) {
    let item = "";
    const command = rawLine.match(/^\*\*\$\s+(.+?)\*\*(?:\s+_\([^)]*\)_)?$/);
    if (command?.[1]) {
      item = `$ ${command[1].trim()}`;
    } else if (/^[-*]\s+/.test(rawLine) || /^\d+\.\s+/.test(rawLine)) {
      item = normalizePreviewLine(rawLine);
    }
    if (!item || item.length < 4 || seen.has(item)) continue;
    seen.add(item);
    items.push(item);
  }
  return items.slice(-maxItems);
}

export function buildAssistantPreview(content: string): AssistantPreview {
  const groomed = groomRunnerTranscript(content);
  const cleaned = groomed.body;
  const plain = stripMarkdownForPreview(cleaned);
  const summaryLines = plain
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("$ "));
  const firstLine = summaryLines[0] ?? "";
  const summary = firstLine.length > 140 ? firstLine.slice(0, 137) + "…" : firstLine;
  const activity = extractAssistantActivity(cleaned);
  const hasHiddenNoise = String(content || "").length > cleaned.length + 40;
  const cleanedNonEmptyLines = cleaned.split("\n").filter((line) => line.trim()).length;
  const hasMore = cleanedNonEmptyLines > 30 || cleaned.length > 2500;
  return {
    summary: summary || "Working...",
    cleaned,
    activity,
    shouldCollapse: hasMore,
    hasHiddenNoise,
  };
}

export function buildLiveAssistantMarkdown(content: string): string {
  const preview = buildAssistantPreview(content);
  const cleaned = preview.cleaned.replace(/```[\s\S]*?```/g, "\n_Code/details hidden while work continues._\n");
  const lines = cleaned.split("\n").map((line) => line.trimEnd());
  const visible: string[] = [];
  let hidden = false;
  let chars = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (visible.length > 0 && visible[visible.length - 1] !== "") visible.push("");
      continue;
    }
    if (/^\*\*\$\s+.+\*\*/.test(line)) {
      hidden = true;
      continue;
    }
    if (/^(workdir|model|provider|approval|sandbox|reasoning effort|session id):/i.test(line)) {
      hidden = true;
      continue;
    }
    if (/^(diff --git|index [0-9a-f]+\.\.[0-9a-f]+|@@ |--- |\+\+\+ )/.test(line)) {
      hidden = true;
      continue;
    }
    if (/^[{}[\];(),.=><:+\-/*\\|'"`_]+$/.test(line)) {
      hidden = true;
      continue;
    }
    visible.push(rawLine);
    chars += rawLine.length;
    if (visible.length >= 12 || chars >= 1400) {
      hidden = true;
      break;
    }
  }

  const body = visible.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!body) return "_Working… implementation details hidden while the task runs._";
  if (!hidden && !preview.activity.length) return body;
  const activity = preview.activity.length
    ? `\n\n${preview.activity.map((item) => `- ${item}`).join("\n")}`
    : "";
  return `${body}${activity}\n\n_Working through implementation details…_`.trim();
}
