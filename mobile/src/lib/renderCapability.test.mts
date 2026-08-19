import test from "node:test";
import assert from "node:assert/strict";

import { REMOTE_RENDER_REQUIRED, remoteRenderRequiredFailure } from "./renderCapability.ts";

test("missing runner is a named render capability failure with an actionable route", () => {
  const failure = remoteRenderRequiredFailure("This TV");
  assert.equal(failure.code, REMOTE_RENDER_REQUIRED);
  assert.match(failure.message, /connected remote runner/i);
  assert.equal(failure.action.route, "/devices");
});
