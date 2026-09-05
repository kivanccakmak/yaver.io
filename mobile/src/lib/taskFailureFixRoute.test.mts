import assert from "node:assert/strict";
import test from "node:test";

import { taskFailureFixRoute } from "./taskFailureFixRoute.ts";

test("OpenCode provider rejection opens API-key settings", () => {
  assert.deepEqual(
    taskFailureFixRoute({ type: "runner_provider_config", runnerId: "opencode" }),
    { kind: "runner-provider-config", runnerId: "opencode" },
  );
});

test("legacy OpenCode browser-auth fix is made safe on mobile", () => {
  assert.deepEqual(
    taskFailureFixRoute({ type: "runner_browser_auth", runnerId: "opencode" }),
    { kind: "runner-provider-config", runnerId: "opencode" },
  );
});

test("Claude and Codex keep their subscription browser-auth route", () => {
  assert.deepEqual(
    taskFailureFixRoute({ type: "runner_browser_auth", runnerId: "claude" }),
    { kind: "runner-auth-needed", runnerId: "claude" },
  );
  assert.deepEqual(
    taskFailureFixRoute({ type: "runner_browser_auth", runnerId: "codex" }),
    { kind: "runner-auth-needed", runnerId: "codex" },
  );
});
