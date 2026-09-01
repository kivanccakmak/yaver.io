import assert from "node:assert/strict";
import test from "node:test";

import { taskRunnerTransportLabel } from "./taskRunnerTransport.ts";

test("runner protocol distinguishes ACP from the phone-to-agent connection", () => {
  assert.equal(taskRunnerTransportLabel("acp"), "ACP");
  assert.equal(taskRunnerTransportLabel("cli-pty"), "CLI / PTY");
  assert.equal(taskRunnerTransportLabel(undefined), null);
});
