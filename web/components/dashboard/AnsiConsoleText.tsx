"use client";

/**
 * AnsiConsoleText — render an ANSI/VT raw stream the way the opencode console
 * looks, in the web chat surfaces.
 *
 * WHY (2026-08-09): the opencode runner streams raw ANSI stdout (`$`
 * prompts, `> build · <model>` banners, git patch +/- lines, 256-color SGR,
 * OSC-8 hyperlinks). The dashboard's chat view used to stripAnsi the stream
 * into a markdown blob — losing every colour the console has — while the
 * xterm Terminal view kept the bytes. This component is the chat view's
 * console: it consumes the SHARED tokenizer/classifier from client-core
 * (`styleAnsiLines` → styled runs + line hints), so web and mobile paint the
 * same grammar from the same code (AGENTS.md: one classifier, no copies).
 *
 * Palette (opencode console look):
 *   banner  — orange/amber, semibold           `> build · <model>`
 *   prompt  — green `$`                       `$ npm run build`
 *   diff-add    — green                        `+const x = 1;`
 *   diff-del    — red                          `-const y = 2;`
 *   diff-hunk   — cyan semibold                `@@ -1,2 +1,3 @@`
 *   diff-header / diff-file — muted on a dark patch background
 *   tool-call   — muted with a green checkmark
 * ANSI fg/bg SGR colours still win where the runner emitted them (the
 * tokenizer carries them); the hint styles are the fallback + grammar layer.
 */

import { memo } from "react";
import { styleAnsiLines, paletteRgb, type AnsiColor, type AnsiToken, type AnsiLineHint } from "@/lib/_core/ansi";

function colorToCss(c: AnsiColor): string {
  if (c.kind === "rgb") return `rgb(${c.rgb![0]},${c.rgb![1]},${c.rgb![2]})`;
  if (c.kind === "palette") {
    const [r, g, b] = paletteRgb(c.index!);
    return `rgb(${r},${g},${b})`;
  }
  const [r, g, b] = paletteRgb(c.index!);
  return `rgb(${r},${g},${b})`;
}

function tokenStyle(t: AnsiToken): React.CSSProperties {
  const s: React.CSSProperties = {};
  if (t.fg) s.color = colorToCss(t.fg);
  if (t.bg) s.backgroundColor = colorToCss(t.bg);
  if (t.bold) s.fontWeight = 700;
  if (t.dim) s.opacity = 0.65;
  if (t.italic) s.fontStyle = "italic";
  if (t.underline) s.textDecoration = "underline";
  if (t.strike) s.textDecoration = "line-through";
  return s;
}

/** Hint-driven fallback styles — used when the runner emitted no SGR colour. */
const HINT_STYLES: Record<AnsiLineHint, React.CSSProperties> = {
  plain: {},
  banner: { color: "#fb923c", fontWeight: 600 },
  prompt: { color: "#4ade80" },
  "diff-header": { color: "#94a3b8", backgroundColor: "rgba(148,163,184,0.08)", fontWeight: 500 },
  "diff-file": { color: "#93c5fd", backgroundColor: "rgba(148,163,184,0.08)", fontWeight: 500 },
  "diff-hunk": { color: "#67e8f9", fontWeight: 600 },
  "diff-add": { color: "#4ade80" },
  "diff-del": { color: "#f87171" },
  "tool-call": { color: "#94a3b8" },
};

function TokenRuns({ tokens }: { tokens: AnsiToken[] }) {
  return (
    <>
      {tokens.map((t, i) => {
        const style = tokenStyle(t);
        const inner = t.text;
        if (t.href) {
          return (
            <a key={i} href={t.href} target="_blank" rel="noreferrer" style={{ ...style, textDecoration: "underline" }} className="break-all">
              {inner}
            </a>
          );
        }
        return (
          <span key={i} style={style} className="break-words">
            {inner}
          </span>
        );
      })}
    </>
  );
}

export const AnsiConsoleText = memo(function AnsiConsoleText({ text, className }: { text: string; className?: string }) {
  const lines = styleAnsiLines(text);
  return (
    <pre className={`whitespace-pre-wrap font-mono text-[12px] leading-5 ${className ?? ""}`}>
      {lines.map((l, i) => (
        <div key={i} className={l.hint !== "plain" ? "rounded px-1.5" : undefined} style={HINT_STYLES[l.hint]}>
          <TokenRuns tokens={l.tokens} />
        </div>
      ))}
    </pre>
  );
});

/**
 * HasConsoleMarkup — cheap detector: does this assistant text carry console
 * shapes worth the ANSI render (ANSI escapes, `$ ` prompts, `> build`
 * banners, git patch markers)? Used to pick AnsiConsoleText over the markdown
 * renderer without re-tokenizing large transcripts twice.
 */
export function hasConsoleMarkup(text: string): boolean {
  if (!text) return false;
  if (text.includes("\u001b[")) return true;
  if (/^\s*>?\s*(build|plan|review|debug)\s*[·•|:]\s*\S+/m.test(text)) return true;
  if (/^\s*\$[ \t]/m.test(text)) return true;
  if (/^diff --git /m.test(text) || /^@@ -\d/m.test(text)) return true;
  return false;
}
