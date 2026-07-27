// darkPalette.test.mts — the dark theme's painted surfaces must stay dark.
//
// Run: node --experimental-strip-types --test src/theme/darkPalette.test.mts
//
// WHY THIS EXISTS
//
// `darkTokens.background` was flipped from "#000000" to "#FF6B00" (orange) in
// 55510579e, a commit about runtime preview targets. It shipped to TestFlight
// 482/483 and repainted the header strip, the Projects/Tasks list background
// and the tab-bar strip bright orange, because `DarkColors.bg` AND
// `DarkColors.bgTabBar` both read that one token.
//
// Nothing caught it: a hex string is a `string` to `tsc`, no screen names the
// value, and every screen kept compiling and rendering. The only detector was a
// human holding the phone. This test is that human, encoded.
//
// It reads the SOURCE rather than importing, because tokens.ts imports
// `react-native` (for `Platform`) and so cannot be loaded by plain node. Same
// approach as beaconParity.test.ts — the file on disk is the artifact that
// ships, so asserting against it is the honest check.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const tokensSrc = readFileSync(join(here, "tokens.ts"), "utf8");
const colorsSrc = readFileSync(join(here, "..", "constants", "colors.ts"), "utf8");

/** Pull one `export const <name> = { ... } as const;` literal out of the source
 *  and return its `key: "#hex"` pairs. Deliberately source-level: the point is
 *  to guard the values that actually ship, not a re-derivation of them. */
function palette(src: string, name: string): Record<string, string> {
  const start = src.indexOf(`export const ${name} = {`);
  assert.ok(start >= 0, `${name} not found in source`);
  const end = src.indexOf("} as const;", start);
  assert.ok(end > start, `${name} literal is not terminated`);
  const body = src.slice(start, end);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s{2}([A-Za-z0-9_]+):\s*"([^"]+)",/gm)) {
    out[m[1]] = m[2];
  }
  return out;
}

/** Relative luminance (WCAG) of a #rrggbb string, 0 = black, 1 = white. */
function luminance(hex: string): number {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  assert.ok(m, `not a 6-digit hex colour: ${hex}`);
  const n = parseInt(m![1], 16);
  const chan = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * chan((n >> 16) & 0xff) +
    0.7152 * chan((n >> 8) & 0xff) +
    0.0722 * chan(n & 0xff)
  );
}

const dark = palette(tokensSrc, "darkTokens");

test("dark theme background is black — the exact value the user asked for", () => {
  assert.equal(dark.background, "#000000");
});

// The exact-value assertion above is the user's stated requirement. This one is
// the class guard: it fails for ANY bright colour landing in a large painted
// surface, not just #FF6B00. Break it by setting background to any accent and
// this test fails before the phone does.
test("every dark painted surface stays dark (luminance guard)", () => {
  for (const key of ["background", "surface", "surfaceElevated", "surfaceMuted"]) {
    const value = dark[key];
    assert.ok(value, `darkTokens.${key} is missing`);
    assert.ok(
      luminance(value) < 0.05,
      `darkTokens.${key} = ${value} is too light for a dark-theme surface ` +
        `(luminance ${luminance(value).toFixed(3)}). An accent/warning colour ` +
        `has probably been pasted into a background slot.`,
    );
  }
});

// If someone re-points bg at a different token, the two assertions above stop
// protecting the screen background. Pin the wiring too.
test("DarkColors.bg and bgTabBar are wired to darkTokens.background", () => {
  const start = colorsSrc.indexOf("export const DarkColors");
  assert.ok(start >= 0, "DarkColors not found");
  const body = colorsSrc.slice(start, colorsSrc.indexOf("export const LightColors"));
  assert.match(body, /^\s{2}bg:\s*darkTokens\.background,$/m);
  assert.match(body, /^\s{2}bgTabBar:\s*darkTokens\.background,$/m);
});

test("the light palette is untouched by the dark fix", () => {
  const light = palette(tokensSrc, "lightTokens");
  assert.equal(light.background, "#F7F7F9");
});
