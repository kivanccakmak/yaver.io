// Light mode uses pale surfaces, not pale foregrounds. This catches the class
// of regression where a colour tuned on black (for example #a78bfa) is copied
// into compact light-mode labels and actions and becomes visually disabled.
//
// Run: node --experimental-strip-types --test src/theme/lightPalette.test.mts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mobile = join(here, "..", "..");
const tokensSrc = readFileSync(join(here, "tokens.ts"), "utf8");

function palette(src: string, name: string): Record<string, string> {
  const start = src.indexOf(`export const ${name} = {`);
  assert.ok(start >= 0, `${name} not found in source`);
  const end = src.indexOf("} as const;", start);
  assert.ok(end > start, `${name} literal is not terminated`);
  const out: Record<string, string> = {};
  for (const match of src.slice(start, end).matchAll(/^\s{2}([A-Za-z0-9_]+):\s*"(#[0-9a-fA-F]{6})",/gm)) {
    out[match[1]] = match[2];
  }
  return out;
}

function luminance(hex: string): number {
  const value = parseInt(hex.slice(1), 16);
  const channel = (byte: number) => {
    const srgb = byte / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel((value >> 16) & 0xff) +
    0.7152 * channel((value >> 8) & 0xff) +
    0.0722 * channel(value & 0xff)
  );
}

function contrast(a: string, b: string): number {
  const lighter = Math.max(luminance(a), luminance(b));
  const darker = Math.min(luminance(a), luminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

const light = palette(tokensSrc, "lightTokens");

test("light semantic foregrounds remain readable on every main light surface", () => {
  const foregrounds = [
    "textPrimary",
    "textSecondary",
    "textTertiary",
    "brandPrimary",
    "statusSuccess",
    "statusInfo",
    "statusWarning",
    "statusError",
    "statusNeutral",
  ];
  const surfaces = ["background", "surface", "surfaceElevated"];

  for (const foreground of foregrounds) {
    for (const surface of surfaces) {
      const ratio = contrast(light[foreground], light[surface]);
      assert.ok(
        ratio >= 4.5,
        `lightTokens.${foreground} (${light[foreground]}) is only ${ratio.toFixed(2)}:1 ` +
          `on ${surface} (${light[surface]}); compact app copy needs at least 4.5:1`,
      );
    }
  }
});

test("Dogfood and preview actions use semantic theme colours, not pale dark-mode purple", () => {
  const files = [
    "app/attach.tsx",
    "app/dogfood-launch.tsx",
    "app/(tabs)/builds.tsx",
    "app/packages.tsx",
    "src/components/AttachModeSection.tsx",
    "src/components/FeedbackOverlay.tsx",
  ];
  const legacy = /#(?:818cf8|a78bfa|c084fc|7c5cff|2e1f3a)/i;
  for (const file of files) {
    const source = readFileSync(join(mobile, file), "utf8");
    assert.doesNotMatch(source, legacy, `${file} reintroduced a dark-mode-only purple action colour`);
  }
});
