// compileFailure.test.mts — the two REAL observed compile failures must
// become compact cards, and healthy output must not.
// Run: node --experimental-strip-types --test src/lib/compileFailure.test.mts

import test from "node:test";
import assert from "node:assert/strict";

import { detectCompileFailure } from "./compileFailure.ts";

test("the FaIconData incident: log tail alone yields a compile card", () => {
  const tail = [
    "Launching lib/main.dart on Web Server in debug mode...",
    "../font_awesome_flutter-10.12.0/lib/src/icon_data.dart:104:36: Error: The class 'IconData' can't be extended outside of its library because it has a base constructor.",
    "class IconDataBrands extends IconData {",
    "Failed to compile application.",
  ];
  const card = detectCompileFailure(undefined, tail);
  assert.ok(card, "no card for a failed compile");
  assert.match(card!.title, /failed to compile/i);
  assert.match(card!.detail, /IconData/);
  assert.match(card!.detail, /Failed to compile application/);
});

test("the e-mobile incident: the agent's persisted status.error wins verbatim", () => {
  const statusError =
    "flutter exited before becoming ready: exit status 1\n" +
    "Error detected in pubspec.yaml:\nNo file or variants found for asset: .env.\nFailed to compile application.\n\n" +
    'What to do: pubspec.yaml lists the asset ".env" but it does not exist…';
  const card = detectCompileFailure(statusError, ["irrelevant log line"]);
  assert.ok(card);
  assert.match(card!.title, /failed to compile/i);
  assert.match(card!.detail, /No file or variants found for asset/);
  assert.match(card!.detail, /What to do/);
});

test("a non-compile status.error still gets a card, honestly titled", () => {
  const card = detectCompileFailure("port 9100 already in use by another process", []);
  assert.ok(card);
  assert.match(card!.title, /dev server reported a failure/i);
});

test("healthy output yields NO card — the card must never cry wolf", () => {
  assert.equal(
    detectCompileFailure(undefined, [
      "Compiling lib/main.dart for the Web...",
      "✓ Built build/web",
      "lib/main.dart is being served at http://0.0.0.0:9100",
    ]),
    null,
  );
  assert.equal(detectCompileFailure("", []), null);
});
