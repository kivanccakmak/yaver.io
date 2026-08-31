import { ansiToPlain, summarizeRawConsole } from "../_core/ansi";

const COLLAPSED_MARKER_RE = /^… (\d+) noisy lines collapsed$/;

function cleanLine(value: string): string {
  return ansiToPlain(String(value || ""))
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(value: string, max = 220): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3).trimEnd()}...`;
}

export function buildTaskConsolePreview(raw: string, running: boolean): string {
  if (!raw) return "";
  const summarized = summarizeRawConsole(raw, running, { budgetLines: 5, budgetChars: 1600 });
  const lines = summarized
    .split("\n")
    .map(cleanLine)
    .filter(Boolean);
  if (lines.length === 0) return running ? "Runner output is streaming." : "Runner output is available.";

  const marker = lines.at(-1)?.match(COLLAPSED_MARKER_RE);
  const collapsed = marker ? String(lines.pop()) : "";
  const preview = clamp(lines.slice(-2).join(" "));
  // A single omitted shell command is not useful context in a compact phone
  // preview. Larger truncation still needs an explicit signal.
  if (preview && collapsed && Number(marker?.[1]) > 1) return `${preview} ${collapsed}`;
  return preview || collapsed || (running ? "Runner output is streaming." : "Runner output is available.");
}
