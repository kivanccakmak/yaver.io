// AUTO-SYNCED from shared/client-core/src/taskPresentation.test.ts.
// DO NOT EDIT IN PLACE. Edit the source and re-run
// scripts/sync-client-core.sh. CI checks drift via `--check`.

import {
  friendlyTaskPresentation,
  isTaskPresentationEvent,
  reduceTaskPresentation,
  type TaskPresentationMessage,
} from "./taskPresentation";

let failures = 0;
function check(condition: unknown, label: string) {
  if (condition) console.log(`ok   ${label}`);
  else { console.error(`FAIL ${label}`); failures++; }
}

const base: TaskPresentationMessage = {
  id: "answer", kind: "message", role: "assistant", text: "Hel",
  createdAt: "2026-08-31T00:00:00Z", updatedAt: "2026-08-31T00:00:00Z",
};
let rows = reduceTaskPresentation([], {
  type: "presentation", schema: 1, op: "upsert", seq: 1, message: base,
});
rows = reduceTaskPresentation(rows, {
  type: "presentation", schema: 1, op: "append", seq: 2,
  message: { ...base, text: "lo", updatedAt: "2026-08-31T00:00:01Z" },
});
check(rows.length === 1 && rows[0].text === "Hello", "append preserves one semantic assistant message");

rows = reduceTaskPresentation(rows, {
  type: "presentation_snapshot", schema: 1, seq: 3,
  messages: [{ ...base, id: "state", kind: "status", role: undefined, text: "Checking the build." }],
});
check(rows.length === 1 && rows[0].id === "state", "snapshot replaces missed live deltas");
check(friendlyTaskPresentation([
  ...rows,
  { ...base, id: "tool", kind: "tool", text: "xcodebuild /private/path", visibility: "details" },
  { ...base, id: "patch", kind: "patch", text: "@@ -1 +1 @@", visibility: "details" },
]).length === 1, "friendly lane excludes detail evidence");
check(friendlyTaskPresentation([{ ...base, id: "future", kind: "new_agent_activity", text: "Checking the update." }]).length === 1,
  "unknown future primary kind remains renderable without a client update");
check(isTaskPresentationEvent({ type: "presentation", schema: 1 }), "schema 1 event is recognized");
check(!isTaskPresentationEvent({ type: "presentation", schema: 2 }), "unknown schema is not guessed");

if (failures) process.exit(1);
