import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const tasksSource = fs.readFileSync(new URL("../../app/(tabs)/tasks.tsx", import.meta.url), "utf8");

test("live task streams yield to taps and input focus", () => {
  assert.match(tasksSource, /const RAW_CONSOLE_RENDER_MS = 500;/);
  assert.match(tasksSource, /startTransition\(\(\) => \{\s*setTasks/);
  assert.match(tasksSource, /rawText=\{rawSnapshot\}/);
  assert.doesNotMatch(tasksSource, /rawText=\{rawBufRef\.current\}/);
});

test("folded console summarizes cheaply and tokenizes the retained tail only when expanded", () => {
  assert.match(
    tasksSource,
    /const collapsedPreview = useMemo\(\s*\(\) => expanded \? "" : buildTaskConsolePreview\(rawText, isRunning\)/,
  );
  assert.match(tasksSource, /if \(!expanded\) return "";[\s\S]*rawText\.slice\(-MOBILE_CONSOLE_RENDER_CAP\)/);
  assert.match(tasksSource, /const LiveConsoleSection = React\.memo/);
});
