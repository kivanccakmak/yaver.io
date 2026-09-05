import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const tasksSource = readFileSync(new URL("../../app/(tabs)/tasks.tsx", import.meta.url), "utf8");

test("live tmux inventory is cleared when the runner machine changes", () => {
  assert.match(
    tasksSource,
    /useEffect\(\(\) => \{\s*setTmuxSessions\(\[\]\);\s*setTmuxLoadError\(null\);\s*\}, \[runnerSelectionDeviceId\]\);/,
  );
});

test("live-session banner requires an observed untracked runner pane", () => {
  assert.match(
    tasksSource,
    /const liveRunnerSessions = tmuxSessions\.filter\(sessionHasUntrackedRunnerPane\);/,
  );
  assert.doesNotMatch(
    tasksSource,
    /const liveRunnerSessions = tmuxSessions\.filter\([\s\S]{0,180}!!sn\.agentType/,
  );
});
