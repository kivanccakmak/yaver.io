// AnsiConsoleText.tsx — render an ANSI/VT raw stream the way the opencode
// console looks, on the mobile chat surface.
//
// WHY (2026-08-09): the opencode runner streams raw ANSI stdout (`$` prompts,
// `> build · <model>` banners, git patch +/- lines, 256-color SGR, OSC-8
// links). The mobile chat bubble flattened it to markdown, losing every
// colour the console has, while the xterm Terminal view kept the bytes. This
// component is the chat's console: it consumes the SHARED tokenizer/
// classifier from client-core (`styleAnsiLines` → styled runs + line hints),
// so web and mobile paint the same grammar from the same code (AGENTS.md:
// one classifier, no copies). Web twin: web/components/dashboard/
// AnsiConsoleText.tsx — keep the palettes in sync.
//
// Palette (opencode console look):
//   banner  — orange, semibold          `> build · <model>`
//   prompt  — green `$`                 `$ npm run build`
//   diff-add    — green                 `+const x = 1;`
//   diff-del    — red                   `-const y = 2;`
//   diff-hunk   — cyan semibold         `@@ -1,2 +1,3 @@`
//   diff-header / diff-file — muted on a dark patch background
//   tool-call   — muted
// ANSI fg/bg SGR colours still win where the runner emitted them.
import React, { memo } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  styleAnsiLines,
  paletteRgb,
  type AnsiColor,
  type AnsiToken,
  type AnsiLineHint,
} from "../_core/ansi";

function colorToCss(c: AnsiColor): string {
  if (c.kind === "rgb") return `rgb(${c.rgb![0]},${c.rgb![1]},${c.rgb![2]})`;
  const [r, g, b] = paletteRgb(c.index ?? 7);
  return `rgb(${r},${g},${b})`;
}

const HINT_COLORS: Record<AnsiLineHint, { color: string; fontWeight?: "600" | "700"; bg?: string }> = {
  plain: { color: "#d1d5db" },
  banner: { color: "#fb923c", fontWeight: "600" },
  prompt: { color: "#4ade80" },
  "diff-header": { color: "#94a3b8", bg: "rgba(148,163,184,0.08)", fontWeight: "600" },
  "diff-file": { color: "#93c5fd", bg: "rgba(148,163,184,0.08)", fontWeight: "600" },
  "diff-hunk": { color: "#67e8f9", fontWeight: "700" },
  "diff-add": { color: "#4ade80" },
  "diff-del": { color: "#f87171" },
  "tool-call": { color: "#94a3b8" },
};

const TokenRuns = memo(function TokenRuns({ tokens }: { tokens: AnsiToken[] }) {
  return (
    <>
      {tokens.map((t, i) => {
        const style: { color?: string; backgroundColor?: string; fontWeight?: "700"; fontStyle?: "italic"; textDecorationLine?: "underline" | "line-through" } = {};
        if (t.fg) style.color = colorToCss(t.fg);
        if (t.bg) style.backgroundColor = colorToCss(t.bg);
        if (t.bold) style.fontWeight = "700";
        if (t.italic) style.fontStyle = "italic";
        if (t.underline || t.strike) style.textDecorationLine = t.underline ? "underline" : "line-through";
        return (
          <Text key={i} style={style}>
            {t.text}
          </Text>
        );
      })}
    </>
  );
});

export const AnsiConsoleText = memo(function AnsiConsoleText({ text, fontSize = 12 }: { text: string; fontSize?: number }) {
  const lines = styleAnsiLines(text);
  return (
    <View>
      {lines.map((l, i) => {
        const hint = HINT_COLORS[l.hint];
        return (
          <Text key={i} selectable style={[s.line, { fontSize, color: hint.color, fontWeight: hint.fontWeight as any, backgroundColor: hint.bg as any }]}>
            <TokenRuns tokens={l.tokens} />
          </Text>
        );
      })}
    </View>
  );
});

/** Cheap detector — does this text carry console shapes worth the ANSI
 *  render? Mirrors web/components/dashboard/AnsiConsoleText.tsx. */
export function hasConsoleMarkup(text: string): boolean {
  if (!text) return false;
  if (text.includes("\u001b[")) return true;
  if (/^\s*>?\s*(build|plan|review|debug)\s*[·•|:]\s*\S+/m.test(text)) return true;
  if (/^\s*\$[ \t]/m.test(text)) return true;
  if (/^diff --git /m.test(text) || /^@@ -\d/m.test(text)) return true;
  return false;
}

const s = StyleSheet.create({
  line: {
    fontFamily: "Menlo",
    lineHeight: 18,
  },
});
