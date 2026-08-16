/**
 * composerKeys.test.ts — `npx tsx lib/composerKeys.test.ts`.
 *
 * Pins the 2026-07-27 "it removed my second line in chat box" regression:
 * Enter must never destroy in-flight text, an IME commit must never submit,
 * and a multi-line prompt must reach the runner with its newlines intact.
 *
 * Prove-the-guard: flip `decideComposerKey` back to the old
 * `key === "Enter" && !shiftKey -> send` and the IME + modifier cases below
 * fail; drop the `^\s+|\s+$` anchors in `normalizeComposerPrompt` for a bare
 * `\s+ -> " "` and the payload-preservation case fails.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  decideComposerKey,
  insertNewline,
  newlineIsNative,
  normalizeComposerPrompt,
} from "./composerKeys";

test("plain Enter sends — the intended UX is preserved", () => {
  assert.equal(decideComposerKey({ key: "Enter" }), "send");
  assert.equal(
    decideComposerKey({ key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }),
    "send",
  );
});

test("every newline chord inserts a line break instead of sending", () => {
  for (const modifier of ["shiftKey", "altKey", "ctrlKey", "metaKey"] as const) {
    assert.equal(
      decideComposerKey({ key: "Enter", [modifier]: true }),
      "newline",
      `${modifier}+Enter must not send`,
    );
  }
});

test("an IME sequence is never a send — both the modern and legacy signal", () => {
  // Modern: KeyboardEvent.isComposing while the candidate window is open.
  assert.equal(decideComposerKey({ key: "Enter", isComposing: true }), "ignore");
  // Legacy engines only ever say 229 here.
  assert.equal(decideComposerKey({ key: "Enter", keyCode: 229 }), "ignore");
  // IME wins even when a modifier is held — hands off entirely.
  assert.equal(decideComposerKey({ key: "Enter", isComposing: true, shiftKey: true }), "ignore");
});

test("non-Enter keys are ignored", () => {
  assert.equal(decideComposerKey({ key: "a" }), "ignore");
  assert.equal(decideComposerKey({ key: "Tab", shiftKey: true }), "ignore");
});

test("only Shift+Enter gets a native line break; the rest need manual insertion", () => {
  assert.equal(newlineIsNative({ key: "Enter", shiftKey: true }), true);
  assert.equal(newlineIsNative({ key: "Enter", altKey: true }), false);
  assert.equal(newlineIsNative({ key: "Enter", metaKey: true }), false);
});

test("insertNewline splices at the caret and over a selection", () => {
  assert.deepEqual(insertNewline("line1line2", 5, 5), { value: "line1\nline2", caret: 6 });
  assert.deepEqual(insertNewline("abXYcd", 2, 4), { value: "ab\ncd", caret: 3 });
  // Out-of-range offsets clamp instead of producing NaN slices.
  assert.deepEqual(insertNewline("ab", 99, 99), { value: "ab\n", caret: 3 });
  assert.deepEqual(insertNewline("ab", -5, -5), { value: "\nab", caret: 1 });
});

test("payload preservation: line1\\nline2 survives normalization intact", () => {
  assert.equal(normalizeComposerPrompt("line1\nline2"), "line1\nline2");
  // Surrounding whitespace goes; interior structure does not.
  assert.equal(normalizeComposerPrompt("\n  line1\nline2  \n"), "line1\nline2");
  assert.equal(
    normalizeComposerPrompt("1. fix login\n2. keep the preview up\n\n3. tell me the URL"),
    "1. fix login\n2. keep the preview up\n\n3. tell me the URL",
  );
  // Blank-only input still normalizes to empty so the send guard holds.
  assert.equal(normalizeComposerPrompt("   \n\n  "), "");
});

test("end-to-end key sequence: typing two lines with Shift+Enter keeps both", () => {
  let value = "line1";
  const chord = { key: "Enter", shiftKey: true } as const;
  assert.equal(decideComposerKey(chord), "newline");
  if (!newlineIsNative(chord)) {
    value = insertNewline(value, value.length, value.length).value;
  } else {
    value += "\n"; // what the textarea does for us
  }
  value += "line2";
  assert.equal(decideComposerKey({ key: "Enter" }), "send");
  assert.equal(normalizeComposerPrompt(value), "line1\nline2");
});
