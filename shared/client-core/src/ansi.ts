/**
 * ansi.ts — ANSI/terminal-stream tokenizer shared by every Yaver surface.
 *
 * WHY THIS EXISTS (2026-08-09): the opencode runner's raw stdout is an ANSI
 * VT stream (`\x1b[0m`, `$` prompts, `> build · <model>` banners, git diff
 * +/- lines, 256-color + truecolor SGR codes, box-drawing TUIs). The
 * dashboard and the mobile app both flattened it to plain text with
 * stripAnsi — losing every colour the console has — while the xterm Terminal
 * view kept the bytes. One shared tokenizer gives BOTH chat surfaces the
 * console look from the SAME code path, so the two renderers can never drift
 * (AGENTS.md: "one shared classifier, no copies"). The web and mobile
 * renderers consume these tokens and paint them with their own primitives
 * (spans / nested Text).
 *
 * This file is platform-neutral: no DOM, no RN. It lives in
 * shared/client-core and is mirrored into mobile/src/_core via
 * scripts/sync-client-core.sh (CI checks drift).
 *
 * Scope: the SGR family (\x1b[<params>m) plus the most common cursor/erase
 * sequences (move, clear-line, clear-screen), which are dropped with a
 * line-split marker so a TUI re-render reads as one block. OSC hyperlinks
 * (\x1b]8;;url\x1b\\ ... \x1b]8;;\x1b\\) are extracted and carried on the
 * token. Everything else is stripped.
 */

export interface AnsiToken {
  /** Plain text content of this run (escape sequences removed). */
  text: string;
  /** Optional OSC-8 hyperlink URL attached to the run. */
  href?: string;
  fg?: AnsiColor;
  bg?: AnsiColor;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

export interface AnsiColor {
  kind: "named" | "rgb" | "palette";
  /** named: 0-15 (standard + bright). palette: 0-255 (xterm-256). */
  index?: number;
  /** rgb: [r,g,b]. */
  rgb?: [number, number, number];
}

/** The 16 standard ANSI colours as RGB (bright variants at 8-15). */
export const ANSI_16_RGB: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],        // 0 black
  [194, 54, 33],    // 1 red (opencode-ish)
  [94, 164, 44],    // 2 green
  [163, 134, 52],   // 3 yellow/orange
  [0, 94, 168],     // 4 blue
  [101, 88, 186],   // 5 magenta
  [44, 142, 158],   // 6 cyan
  [190, 190, 190],  // 7 white
  [128, 128, 128],  // 8 bright black
  [255, 113, 89],   // 9 bright red
  [134, 214, 92],   // 10 bright green
  [229, 201, 84],   // 11 bright yellow
  [88, 156, 245],   // 12 bright blue
  [184, 146, 255],  // 13 bright magenta
  [112, 213, 226],  // 14 bright cyan
  [240, 240, 240],  // 15 bright white
];

/** The xterm-256 colour cube / greys (index 16-255). */
const PALETTE_RGB = (() => {
  const out: [number, number, number][] = [];
  // 16-231: 6x6x6 colour cube.
  for (let i = 0; i < 216; i++) {
    const r = Math.round((i / 36) % 6) * 51;
    const g = Math.round((i / 6) % 6) * 51;
    const b = (i % 6) * 51;
    out.push([r, g, b]);
  }
  // 232-255: 24-step grey ramp.
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    out.push([v, v, v]);
  }
  return out;
})();

/** Map an xterm-256 palette index to RGB. */
export function paletteRgb(index: number): [number, number, number] {
  if (index >= 0 && index < 16) return [...ANSI_16_RGB[index]] as [number, number, number];
  if (index >= 16 && index < 256) return PALETTE_RGB[index - 16];
  return [190, 190, 190];
}

/** Truecolor/rgb approximation of a 256-colour index (used when a surface
 *  can't map the palette exactly). */
const OSC_LINK_OPEN = /\x1b\]8;;([^\x07]*)\x07/;

/** Schemes an OSC-8 hyperlink may carry. Anything else — `javascript:`,
 *  `data:`, `vbscript:`, a bare protocol-relative `//`, or a scheme-less
 *  string that React would still accept as a URL — is dropped so a
 *  prompt-injected link can never execute in the dashboard origin. This is
 *  the web-side half of the audit finding "OSC-8 `javascript:` href XSS"
 *  (docs/audits/webui-chat-vibing-gui-2026-08-12.md §6.1): the tokenizer is
 *  the single choke point every renderer (AnsiConsoleText, terminal views)
 *  shares, so sanitising here protects all of them.
 */
// http(s):// and mailto: (mailto has no "//"). Everything else fails.
const OSC_LINK_SAFE = /^(https?:\/\/|mailto:)/i;

/** Returns the href to carry on the token, or "" when the URL is unsafe. */
function sanitizeOscLink(url: string): string {
  const trimmed = (url || "").trim();
  if (!trimmed) return "";
  // `javascript:alert(1)` fails the allowlist; `//evil.com` is
  // protocol-relative and must not become a same-origin jump; a bare
  // `alert(1)` without a scheme is not a URL at all. Only explicit
  // http(s):// or mailto: links pass.
  if (!OSC_LINK_SAFE.test(trimmed)) return "";
  return trimmed;
}

export interface TokenizeOptions {
  /** Keep cursor/erase sequences as line breaks instead of dropping them
   *  silently (default true: a TUI repaint becomes a blank line). */
  keepEraseLines?: boolean;
}

/**
 * Tokenize an ANSI/VT stream into styled runs. Pure, deterministic,
 * dependency-free — unit-tested in ansi.test.ts.
 */
export function tokenizeAnsi(input: string, opts?: TokenizeOptions): AnsiToken[] {
  if (!input) return [];
  const keepEraseLines = opts?.keepEraseLines ?? true;
  const tokens: AnsiToken[] = [];

  let fg: AnsiColor | undefined;
  let bg: AnsiColor | undefined;
  let bold = false;
  let dim = false;
  let italic = false;
  let underline = false;
  let strike = false;
  let buf = "";
  // Current open OSC-8 link (the ESC\ BEL...ST form), if any.
  let linkUrl: string | undefined;

  const pushBuf = (href?: string) => {
    if (!buf) return;
    tokens.push({
      text: buf,
      ...(href || linkUrl ? { href: href || linkUrl } : {}),
      ...(fg ? { fg } : {}),
      ...(bg ? { bg } : {}),
      ...(bold ? { bold: true } : {}),
      ...(dim ? { dim: true } : {}),
      ...(italic ? { italic: true } : {}),
      ...(underline ? { underline: true } : {}),
      ...(strike ? { strike: true } : {}),
    });
    buf = "";
  };

  const applySgr = (params: string) => {
    if (!params) { // bare \x1b[m === reset
      fg = undefined; bg = undefined; bold = false; dim = false;
      italic = false; underline = false; strike = false;
      return;
    }
    const parts = params.split(";");
    let i = 0;
    while (i < parts.length) {
      const code = parts[i];
      if (code === "") { fg = undefined; bg = undefined; bold = false; dim = false; italic = false; underline = false; strike = false; i++; continue; }
      const n = parseInt(code, 10);
      if (isNaN(n)) { i++; continue; }
      switch (n) {
        case 0: fg = undefined; bg = undefined; bold = false; dim = false; italic = false; underline = false; strike = false; break;
        case 1: bold = true; break;
        case 2: dim = true; break;
        case 3: italic = true; break;
        case 4: underline = true; break;
        case 7: /* reverse video — swap fg/bg */ { const t = fg; fg = bg; bg = t; break; }
        case 9: strike = true; break;
        case 22: bold = false; dim = false; break;
        case 23: italic = false; break;
        case 24: underline = false; break;
        case 29: strike = false; break;
        case 30: case 31: case 32: case 33: case 34: case 35: case 36: case 37:
          fg = { kind: "named", index: n - 30 }; break;
        case 38: {
          const t = parseExtendedColor(parts, i + 1);
          if (t) { fg = t.color; i = t.next; }
          break;
        }
        case 39: fg = undefined; break;
        case 40: case 41: case 42: case 43: case 44: case 45: case 46: case 47:
          bg = { kind: "named", index: n - 40 }; break;
        case 48: {
          const t = parseExtendedColor(parts, i + 1);
          if (t) { bg = t.color; i = t.next; }
          break;
        }
        case 49: bg = undefined; break;
        case 90: case 91: case 92: case 93: case 94: case 95: case 96: case 97:
          fg = { kind: "named", index: n - 90 + 8 }; break;
        case 100: case 101: case 102: case 103: case 104: case 105: case 106: case 107:
          bg = { kind: "named", index: n - 100 + 8 }; break;
        default: /* unknown — ignore */ break;
      }
      i++;
    }
  };

  /** Parse 38/48 extended colours: `;5;<idx>` (256) or `;2;r;g;b` (truecolor). */
  const parseExtendedColor = (parts: string[], from: number): { color: AnsiColor; next: number } | null => {
    const mode = parts[from];
    if (mode === "5") {
      const idx = parseInt(parts[from + 1] ?? "", 10);
      if (!isNaN(idx)) return { color: { kind: "palette", index: idx }, next: from + 1 };
    } else if (mode === "2") {
      const r = parseInt(parts[from + 1] ?? "", 10);
      const g = parseInt(parts[from + 2] ?? "", 10);
      const b = parseInt(parts[from + 3] ?? "", 10);
      if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return { color: { kind: "rgb", rgb: [r, g, b] }, next: from + 3 };
    }
    return null;
  };

  // Master scan: match SGR/control escapes OR OSC-8 hyperlink shells in one
  // pass so link offsets can never drift from the text they wrap.
  const MASTER = /(\x1b\]8;;[^\x07]*\x07[\s\S]*?\x1b\]8;;\x07)|(\x1b\[[0-9;:]*[A-Za-z])/g;
  MASTER.lastIndex = 0;
  let m: RegExpExecArray | null;
  let prevEnd = 0;
  while ((m = MASTER.exec(input)) !== null) {
    const osc = m[1];
    const esc = m[2];
    const start = m.index;
    // Accumulate the plain text since the previous escape into buf.
    if (start > prevEnd) {
      buf += input.slice(prevEnd, start);
    }
    if (osc) {
      // OSC-8 hyperlink shell: \x1b]8;;<url>\x07<text>\x1b]8;;\x07
      const open = osc.match(OSC_LINK_OPEN);
      const url = sanitizeOscLink(open ? open[1] : "");
      // Strip the shell, keep only the inner text.
      const inner = osc.replace(/\x1b\]8;;[^\x07]*\x07/, "").replace(/\x1b\]8;;\x07$/, "");
      buf += inner;
      pushBuf(url || undefined);
      linkUrl = undefined;
    } else if (esc) {
      const params = esc.slice(2, -1);
      const cmd = esc.slice(-1);
      if (cmd === "m") {
        pushBuf();
        applySgr(params);
      } else {
        // Non-SGR control (cursor move, erase, etc.). Keep text before it,
        // then treat the sequence as a boundary.
        pushBuf();
        if (keepEraseLines && (cmd === "K" || cmd === "J" || cmd === "H" || cmd === "A")) {
          tokens.push({ text: "\n" });
        }
      }
    }
    prevEnd = MASTER.lastIndex;
  }
  if (prevEnd < input.length) {
    buf += input.slice(prevEnd);
  }
  pushBuf();

  // Merge adjacent tokens with identical style so a stream that toggles
  // `\x1b[0m` between runs (the opencode banner does this constantly) stays
  // readable as contiguous text instead of fragmenting into per-escape runs.
  const merged: AnsiToken[] = [];
  for (const t of tokens) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.href === t.href &&
      last.bold === t.bold &&
      last.dim === t.dim &&
      last.italic === t.italic &&
      last.underline === t.underline &&
      last.strike === t.strike &&
      JSON.stringify(last.fg) === JSON.stringify(t.fg) &&
      JSON.stringify(last.bg) === JSON.stringify(t.bg)
    ) {
      last.text += t.text;
    } else {
      merged.push({ ...t });
    }
  }

  return merged;
}

/** Convenience: flatten tokens to plain text (strip all styling). */
export function ansiToPlain(input: string): string {
  return tokenizeAnsi(input)
    .map((t) => t.text)
    .join("");
}

/** Split a token stream into lines, preserving per-token styling. */
export interface AnsiLine {
  tokens: AnsiToken[];
}

export function tokenStreamToLines(tokens: AnsiToken[]): AnsiLine[] {
  const lines: AnsiLine[] = [];
  let current: AnsiToken[] = [];
  for (const t of tokens) {
    const parts = t.text.split("\n");
    parts.forEach((seg, idx) => {
      if (idx > 0) {
        lines.push({ tokens: current });
        current = [];
      }
      if (seg.length > 0) {
        current.push({ ...t, text: seg });
      }
    });
  }
  if (current.length > 0) lines.push({ tokens: current });
  return lines;
}

/**
 * Structural console-line classification (opencode console look, 2026-08-09).
 *
 * The opencode runner's raw stream is full of shapes a plain-text render
 * flattens: `> build · <model>` banner lines, `$ command` prompt lines, git
 * patch output (`diff --git`, `+added`, `-removed`, `@@ hunk @@`), and
 * tool/status prefixes. The terminal view renders these with xterm's own
 * palette; the CHAT views on web + mobile used to strip every trace of them.
 * One shared classifier lets both chat renderers paint the same console
 * grammar from the same code path — a line is a hint, the renderer decides
 * the exact colour, and the two surfaces can never drift.
 *
 * Pure, deterministic, unit-tested in ansi.test.ts.
 */
export type AnsiLineHint =
  | "plain"       // nothing special
  | "banner"      // `> build · <model>` / `> plan · <model>` (opencode header)
  | "prompt"      // `$ command` (shell prompt the runner is about to run)
  | "diff-header" // `diff --git a/… b/…`
  | "diff-file"   // `--- a/…` / `+++ b/…`
  | "diff-hunk"   // `@@ -1,2 +1,2 @@`
  | "diff-add"    // `+added` line in a patch
  | "diff-del"    // `-removed` line in a patch
  | "tool-call";  // `⎿  run <cmd>` opencode tool-call tail or `✓`/`✗` status

const BANNER_RE = /^\s*>?\s*(build|plan|review|debug)\s*[·•|:]\s*\S+/;
const PROMPT_RE = /^\s*\$[ \t]/;
const DIFF_HEADER_RE = /^diff --git \S+ \S+$/;
const DIFF_FILE_RE = /^(\+\+\+|---) [ab]\/\S+/;
const DIFF_HUNK_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
const TOOL_TAIL_RE = /^\s*(⎿|└|├)\s*/;
const STATUS_RE = /^\s*[✓✗]\s+\S/;

export function classifyAnsiLine(plain: string): AnsiLineHint {
  const s = plain.replace(/\s+$/g, "");
  if (!s) return "plain";
  if (BANNER_RE.test(s)) return "banner";
  if (PROMPT_RE.test(s)) return "prompt";
  if (DIFF_HEADER_RE.test(s)) return "diff-header";
  if (DIFF_FILE_RE.test(s)) return "diff-file";
  if (DIFF_HUNK_RE.test(s)) return "diff-hunk";
  if (s.startsWith("+") && !s.startsWith("+++")) return "diff-add";
  if (s.startsWith("-") && !s.startsWith("---")) return "diff-del";
  if (TOOL_TAIL_RE.test(s) || STATUS_RE.test(s)) return "tool-call";
  return "plain";
}

/**
 * One-stop helper: tokenize a raw stream and return per-line hints aligned
 * with the token lines, so a renderer can paint both colour runs and line
 * grammar from a single pass.
 */
export interface AnsiStyledLine {
  hint: AnsiLineHint;
  plain: string;
  tokens: AnsiToken[];
}

export function styleAnsiLines(input: string): AnsiStyledLine[] {
  const lines = tokenStreamToLines(tokenizeAnsi(input));
  return lines.map((l) => {
    const plain = l.tokens.map((t) => t.text).join("");
    return { hint: classifyAnsiLine(plain), plain, tokens: l.tokens };
  });
}
