// AUTO-SYNCED from shared/client-core/src/ansi.test.ts.
// DO NOT EDIT IN PLACE. Edit the source and re-run
// scripts/sync-client-core.sh. CI checks drift via `--check`.

/**
 * ansi.test.ts — guards for the shared ANSI tokenizer.
 *
 * The bug this exists for (2026-08-09): the dashboard and mobile app both
 * flattened opencode's raw ANSI stream to plain text with stripAnsi, losing
 * every colour the console has, while the xterm Terminal view kept the
 * bytes — two surfaces, two looks, one product. The tokenizer below is the
 * single classifier both chat renderers consume; these tests pin the tokens
 * so a renderer drift (web spans vs mobile nested Text) can never silently
 * change what a user sees.
 *
 * Run: npx tsx shared/client-core/src/ansi.test.ts
 */
import {
  ANSI_16_RGB,
  tokenizeAnsi,
  ansiToPlain,
  tokenStreamToLines,
  paletteRgb,
  classifyAnsiLine,
  styleAnsiLines,
  summarizeRawConsole,
} from "./ansi";

let failures = 0;
const eq = (got: unknown, want: unknown, label: string) => {
  if (JSON.stringify(got) === JSON.stringify(want)) console.log(`ok   ${label}`);
  else { console.error(`FAIL ${label}:\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); failures++; }
};
const ok = (c: unknown, label: string) => eq(Boolean(c), true, label);

// ── plain text passes through untouched ─────────────────────────────────
{
  const t = tokenizeAnsi("hello world");
  eq(t, [{ text: "hello world" }], "plain text → single unstyled token");
}

// ── SGR colours ──────────────────────────────────────────────────────────
{
  const t = tokenizeAnsi("\x1b[31mred\x1b[0m plain");
  eq(t, [
    { text: "red", fg: { kind: "named", index: 1 } },
    { text: " plain" },
  ], "red text then reset → two tokens");
}
{
  const t = tokenizeAnsi("\x1b[32m+\x1b[0m added");
  eq(t, [
    { text: "+", fg: { kind: "named", index: 2 } },
    { text: " added" },
  ], "green + line (git patch)");
}
{
  const t = tokenizeAnsi("\x1b[1m\x1b[33m$ ls\x1b[0m");
  eq(t, [
    { text: "$ ls", fg: { kind: "named", index: 3 }, bold: true },
  ], "bold yellow $ prompt");
}

// ── 256-colour palette ──────────────────────────────────────────────────
{
  const t = tokenizeAnsi("\x1b[38;5;208morange\x1b[0m");
  eq(t, [
    { text: "orange", fg: { kind: "palette", index: 208 } },
  ], "xterm-256 orange (208)");
}
{
  const [r, g, b] = paletteRgb(208);
  ok(r > 200 && g > 80 && g < 160 && b < 60, "palette 208 is orange-ish RGB");
}
{
  const [r, g, b] = paletteRgb(2);
  eq([r, g, b], [...ANSI_16_RGB[2]], "palette index <16 maps to the standard 16");
}

// ── truecolor ───────────────────────────────────────────────────────────
{
  const t = tokenizeAnsi("\x1b[38;2;255;120;50mtrue\x1b[0m");
  eq(t, [
    { text: "true", fg: { kind: "rgb", rgb: [255, 120, 50] } },
  ], "truecolor SGR 38;2;r;g;b");
}

// ── background ──────────────────────────────────────────────────────────
{
  const t = tokenizeAnsi("\x1b[48;5;236mgray bg\x1b[0m");
  eq(t, [
    { text: "gray bg", bg: { kind: "palette", index: 236 } },
  ], "xterm-256 background (patch gray)");
}

// ── bold / dim / underline / strike ─────────────────────────────────────
{
  const t = tokenizeAnsi("\x1b[1mbold\x1b[22m \x1b[2mdim\x1b[0m \x1b[4munder\x1b[0m \x1b[9mstrike\x1b[0m");
  eq(t, [
    { text: "bold", bold: true },
    { text: " " },
    { text: "dim", dim: true },
    { text: " " },
    { text: "under", underline: true },
    { text: " " },
    { text: "strike", strike: true },
  ], "bold/dim/underline/strike attributes");
}

// ── bare \x1b[m resets (the opencode banner emits this constantly) ─────
{
  const t = tokenizeAnsi("\x1b[0m\n> build · deepseek-v4-flash\n\x1b[0m\n");
  eq(t, [
    { text: "\n> build · deepseek-v4-flash\n\n" },
  ], "bare [0m sequences are dropped, text survives");
}

// ── $ prompt lines in a real opencode run ───────────────────────────────
{
  const raw = "\x1b[0m\n> build · deepseek-v4-flash\n\x1b[0m\n\x1b[0m$ \x1b[0mls -la\n";
  const t = tokenizeAnsi(raw);
  eq(ansiToPlain(raw), "\n> build · deepseek-v4-flash\n\n$ ls -la\n", "plain extraction matches the visible console text");
  const lines = tokenStreamToLines(t);
  ok(lines.length >= 4, "token stream splits into lines at newlines");
  const last = lines[lines.length - 1];
  ok(last.tokens.some((tk) => tk.text.includes("$ ls -la")), "last line carries the $ prompt text");
}

// ── OSC-8 hyperlink extraction ──────────────────────────────────────────
{
  const t = tokenizeAnsi("\x1b]8;;https://example.com\x07link text\x1b]8;;\x07 rest");
  eq(t[0]?.href, "https://example.com", "OSC-8 link URL carried on the token");
  eq(t[0]?.text, "link text", "OSC-8 link inner text kept");
  eq(t[1]?.text, " rest", "text after link kept unstyled");
}

// ── OSC-8 scheme allowlist (the audit XSS finding, §6.1) ───────────────
// A prompt-injected \x1b]8;;javascript:…\x07 link used to reach the renderer
// verbatim and become an <a href> in the dashboard origin. The tokenizer now
// drops every scheme except http(s):// and mailto:// — the link becomes plain
// text, never a clickable/executable URL.
{
  const evil = "\x1b]8;;javascript:alert(1)\x07click\x1b]8;;\x07";
  const t = tokenizeAnsi(evil);
  eq(t[0]?.href, undefined, "javascript: OSC-8 link is not carried as href");
  eq(t[0]?.text, "click", "the inner text survives as plain text");

  const data = tokenizeAnsi("\x1b]8;;data:text/html,<script>1</script>\x07x\x1b]8;;\x07");
  eq(data[0]?.href, undefined, "data: OSC-8 link is dropped");

  const proto = tokenizeAnsi("\x1b]8;;//evil.example/path\x07x\x1b]8;;\x07");
  eq(proto[0]?.href, undefined, "protocol-relative OSC-8 link is dropped");

  const bare = tokenizeAnsi("\x1b]8;;alert(1)\x07x\x1b]8;;\x07");
  eq(bare[0]?.href, undefined, "scheme-less OSC-8 string is dropped");

  const mail = tokenizeAnsi("\x1b]8;;mailto:a@b.co\x07mail\x1b]8;;\x07");
  eq(mail[0]?.href, "mailto:a@b.co", "mailto: OSC-8 link is allowed");
}

// ── cursor/erase sequences become line breaks (TUI repaint) ─────────────
{
  const t = tokenizeAnsi("line1\x1b[2Kline2");
  const plain = t.map((x) => x.text).join("");
  ok(plain.includes("\n"), "erase-line (K) leaves a line boundary for a repaint");
}

// ── unknown SGR codes are ignored, text survives ────────────────────────
{
  const t = tokenizeAnsi("\x1b[999mweird\x1b[0m ok");
  eq(t, [
    { text: "weird ok" },
  ], "unknown SGR code ignored, adjacent runs merge (no visible style change)");
}

if (failures > 0) {
  console.error(`\n${failures} FAILURE(s)`);
  process.exit(1);
}

// ── structural console-line classification ──────────────────────────────
{
  eq(classifyAnsiLine("> build · deepseek-v4-flash"), "banner", "opencode build banner");
  eq(classifyAnsiLine("> plan · gpt-5.4"), "banner", "opencode plan banner");
  eq(classifyAnsiLine("$ ls -la"), "prompt", "$ prompt");
  eq(classifyAnsiLine("$"), "plain", "lone $ is plain (no command)");
  eq(classifyAnsiLine("diff --git a/x.ts b/x.ts"), "diff-header", "git diff header");
  eq(classifyAnsiLine("+++ b/src/x.ts"), "diff-file", "+++ file line");
  eq(classifyAnsiLine("--- a/src/x.ts"), "diff-file", "--- file line");
  eq(classifyAnsiLine("@@ -1,2 +1,3 @@"), "diff-hunk", "hunk header");
  eq(classifyAnsiLine("+const x = 1;"), "diff-add", "patch add");
  eq(classifyAnsiLine("-const y = 2;"), "diff-del", "patch del");
  eq(classifyAnsiLine("  + indented keeps leading"), "plain", "indented + is not a patch add");
  eq(classifyAnsiLine("⎿  run npx tsc"), "tool-call", "opencode tool tail");
  eq(classifyAnsiLine("✓ 3 files changed"), "tool-call", "checkmark status");
  eq(classifyAnsiLine("normal output line"), "plain", "ordinary line");
}
{
  const styled = styleAnsiLines("\x1b[0m\n> build · deepseek-v4-flash\n\x1b[0m\n$ \x1b[0mls\n");
  ok(styled.length >= 4, "styleAnsiLines splits into lines");
  const hints = styled.map((l) => l.hint);
  ok(hints.includes("banner"), "banner line classified through the one-stop helper");
  ok(hints.includes("prompt"), "$ prompt classified through the one-stop helper");
}

// ── summarizeRawConsole (shared noisy-console reducer) ──────────────────
{
  const raw = [
    "> build · deepseek-v4-flash",     // banner — kept
    "$ npm run build",                  // prompt echo — dropped
    "workdir: /repo",                   // runner config banner — dropped
    "compiled 42 files",                // real output — kept
    "compiled 42 files",                // repeat
    "compiled 42 files",                // 3rd repeat — collapsed
    "compiled 42 files",                // 4th — dropped
    "diff --git a/x.ts b/x.ts",        // diff hunk — dropped
    "──────────",                       // TUI redraw edge — dropped
    "✓ done",                           // status — kept
  ].join("\n");
  const out = summarizeRawConsole(raw, false);
  ok(out.includes("> build · deepseek-v4-flash"), "banner survives");
  ok(!out.includes("$ npm run build"), "$ echo dropped");
  ok(!out.includes("workdir:"), "config banner dropped");
  ok(out.includes("compiled 42 files"), "real output kept");
  ok(!out.includes("diff --git"), "diff hunk dropped");
  ok(!out.includes("──────────"), "TUI redraw edge dropped");
  ok(out.includes("✓ done"), "status kept");
  ok(out.includes("noisy lines collapsed"), "collapse count reported");
  // Running budget is tighter than finished.
  const big = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const running = summarizeRawConsole(big, true).split("\n").length;
  const finished = summarizeRawConsole(big, false).split("\n").length;
  ok(running < finished, "running budget tighter than finished budget");
  // KEEP THE TAIL (2026-08-13): the summarizer evicts the OLDEST kept line
  // when the budget is full, so a live console follows the newest output —
  // never drops it. The old head-keeping bug froze the web task console at
  // the START of a long run while the header claimed it was live.
  const tail = summarizeRawConsole(big, true).split("\n");
  ok(tail.some((l) => l.startsWith("line 199")), "newest output survives the budget (tail kept)");
  ok(!tail.some((l) => l.startsWith("line 0")), "oldest output evicted to make room");
  // The tail must still be recognizably the END of the stream, and the
  // collapse marker must not masquerade as a kept line.
  const noMarker = tail.filter((l) => !l.startsWith("… "));
  ok(noMarker[0].startsWith("line 160"), "first kept line is the oldest evicted window start (budget 40 of 200)");
  // ANSI on kept lines survives (so AnsiConsoleText can still paint them).
  const ansiLine = "\x1b[31mred text\x1b[0m";
  ok(summarizeRawConsole(ansiLine, false).includes("\x1b[31m"), "kept lines keep their escapes");

  // A retained runner buffer can be hundreds of KiB. The compact reducer must
  // only parse a bounded tail, while preserving the newest output and an
  // honest indication that older lines were omitted.
  const oversized = [
    "EARLY_SENTINEL " + "x".repeat(160),
    ...Array.from({ length: 5000 }, (_, i) => `noise-${i} ${"x".repeat(80)}`),
    "LATEST_SENTINEL",
  ].join("\n");
  const oversizedTail = summarizeRawConsole(oversized, true);
  ok(!oversizedTail.includes("EARLY_SENTINEL"), "oversized console does not parse/render its old head");
  ok(oversizedTail.includes("LATEST_SENTINEL"), "oversized console preserves newest output");
  ok(oversizedTail.includes("noisy lines collapsed"), "oversized console reports omitted history");
}

if (failures > 0) {
  console.error(`\n${failures} ansi test${failures === 1 ? "" : "s"} failed`);
  process.exitCode = 1;
} else {
  console.log("\nall ansi tests pass");
}
