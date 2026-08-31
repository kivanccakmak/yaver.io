import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const tasksSource = readFileSync(new URL("../../app/(tabs)/tasks.tsx", import.meta.url), "utf8");

test("session messages copy their exact turn text on long press", () => {
  assert.match(tasksSource, /ExpoClipboard\.setStringAsync\(turn\.content\)/);
  assert.match(tasksSource, /copyInFlightRef/);
  assert.match(tasksSource, /Alert\.alert\("Copy failed", "Yaver could not access the clipboard\. Try again\."\)/);
  assert.equal(
    [...tasksSource.matchAll(/onLongPress=\{copyMessage\}/g)].length,
    2,
    "both the user and runner bubbles must expose the shared copy gesture",
  );
  assert.match(tasksSource, /accessibilityHint="Long press to copy this message"/);
  assert.match(tasksSource, /accessibilityHint="Long press to copy this runner message"/);
});

test("runner raw output remains an explicit action instead of owning long press", () => {
  assert.doesNotMatch(tasksSource, /onLongPress=\{\(\) => setShowRaw/);
  assert.match(tasksSource, /onPress=\{\(\) => setShowRaw/);
  assert.match(tasksSource, /\{showRaw \? "Hide raw" : "Raw"\}/);
});
