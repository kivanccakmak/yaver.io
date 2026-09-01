import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The native client owns the final projection from the agent TaskInfo wire
// shape. A detail refresh used to silently drop presentation, transport, and
// reasoning fields even though the agent had produced them; reopening a task
// therefore looked less readable than the live stream. Keep the two mapping
// sites explicit until quic.ts is split into a pure projection module.
test("native Task list and detail preserve agent-owned presentation fields", () => {
  const src = readFileSync(new URL("./quic.ts", import.meta.url), "utf8");
  const getTask = src.slice(src.indexOf("async getTask(taskId"), src.indexOf("/** Recent Vibing"));
  const listTasks = src.slice(src.indexOf("async listTasks()"), src.indexOf("/** Get a single task"));
  for (const [name, block] of [["detail", getTask], ["list", listTasks]] as const) {
    assert.match(block, /presentation:\s*Array\.isArray\(t\.presentation\)/, `${name} drops presentation`);
    assert.match(block, /transport:\s*t\.transport/, `${name} drops execution transport`);
    assert.match(block, /transportReason:\s*t\.transportReason/, `${name} drops fallback explanation`);
    assert.match(block, /reasoningEffort:\s*t\.reasoningEffort/, `${name} drops ACP reasoning selection`);
  }
});
