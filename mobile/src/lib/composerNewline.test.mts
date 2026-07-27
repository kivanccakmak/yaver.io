// composerNewline.test.mts — cross-surface guard for the 2026-07-27
// "it removed my second line in chat box" incident.
// Run: node --experimental-strip-types --test src/lib/composerNewline.test.mts
//
// The bug landed on WEB (web/components/dashboard/RuntimeLabView.tsx): a bare
// `key === "Enter" && !shiftKey -> send` submitted while the user was still
// typing, so pressing Enter to start line 2 sent line 1 and the rest was lost.
// Mobile was already correct — its chat composers are `multiline` TextInputs
// with no `onSubmitEditing`, so the Return key inserts a line break on native
// AND on RN-web — but "correct today" is not a guarantee. Adding
// `onSubmitEditing` (or dropping `multiline`) to either composer reintroduces
// the exact same data-destroying behaviour on the phone, and nothing in `tsc`
// would notice.
//
// So this test reads the real source and pins the two properties that make a
// chat composer safe to type multiple lines into. Prove the guard by breaking
// it: add `onSubmitEditing={...}` to the composer at tasks.tsx and watch the
// second assertion fail.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const tasksSource = readFileSync(join(repoRoot, "mobile", "app", "(tabs)", "tasks.tsx"), "utf8");

/**
 * Slice out the JSX element that binds `value={<stateName>}` — the composer —
 * so we assert against that element and not some unrelated TextInput.
 */
function composerElement(source: string, stateName: string): string {
  const marker = `value={${stateName}}`;
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `composer bound to ${stateName} not found in tasks.tsx`);
  const open = source.lastIndexOf("<TextInput", at);
  assert.notEqual(open, -1, `${stateName} is not bound to a <TextInput>`);
  const close = source.indexOf("/>", at);
  assert.notEqual(close, -1, `unterminated <TextInput> for ${stateName}`);
  return source.slice(open, close + 2);
}

const COMPOSERS: Array<[label: string, state: string]> = [
  ["main task composer", "newTaskText"],
  ["follow-up composer", "followUpText"],
];

for (const [label, state] of COMPOSERS) {
  test(`${label} accepts multiple lines`, () => {
    const element = composerElement(tasksSource, state);
    assert.match(
      element,
      /\bmultiline\b/,
      `${label} must stay multiline — a single-line TextInput cannot hold a second line at all`,
    );
  });

  test(`${label} never submits on Return`, () => {
    const element = composerElement(tasksSource, state);
    assert.doesNotMatch(
      element,
      /onSubmitEditing/,
      `${label} must not submit on Return — that is the web bug (Enter ate line 2) ported to the phone`,
    );
    // blurOnSubmit/submitBehavior="submit" makes Return dismiss the keyboard
    // mid-message, which loses the caret and reads as "it swallowed my line".
    assert.doesNotMatch(
      element,
      /submitBehavior=\{?["']submit["']\}?/,
      `${label} must not use submitBehavior="submit"`,
    );
    assert.doesNotMatch(
      element,
      /blurOnSubmit=\{true\}/,
      `${label} must not blur on Return`,
    );
  });
}

test("the web fix exists and is the shared seam both web composers use", () => {
  const lib = readFileSync(join(repoRoot, "web", "lib", "composerKeys.ts"), "utf8");
  assert.match(lib, /isComposing/, "web composer key logic must guard IME composition");
  for (const file of [
    join("web", "components", "dashboard", "RuntimeLabView.tsx"),
    join("web", "app", "dashboard", "page.tsx"),
  ]) {
    const source = readFileSync(join(repoRoot, file), "utf8");
    assert.match(
      source,
      /decideComposerKey/,
      `${file} must route Enter through decideComposerKey, not an inline shiftKey check`,
    );
    assert.doesNotMatch(
      source,
      /key === "Enter" && !e(?:vent)?\.shiftKey/,
      `${file} still has the raw Enter-sends handler that destroyed line 2`,
    );
  }
});
