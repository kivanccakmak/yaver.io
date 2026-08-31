import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const tasksSource = fs.readFileSync(new URL("../../app/(tabs)/tasks.tsx", import.meta.url), "utf8");

test("live task streams yield to taps and input focus", () => {
  assert.match(tasksSource, /const TASK_OUTPUT_FLUSH_MS = 500;/);
  assert.match(tasksSource, /const RAW_CONSOLE_RENDER_MS = 500;/);
  assert.match(tasksSource, /startTransition\(\(\) => \{\s*setTasks/);
  assert.match(tasksSource, /rawText=\{rawSnapshot\}/);
  assert.doesNotMatch(tasksSource, /rawText=\{rawBufRef\.current\}/);
});

test("folded console does not parse retained logs", () => {
  assert.match(
    tasksSource,
    /const summarizedText = useMemo\(\s*\(\) => expanded \? summarizeRawConsole\(rawText, isRunning\) : ""/,
  );
  assert.match(tasksSource, /const LiveConsoleSection = React\.memo/);
});
