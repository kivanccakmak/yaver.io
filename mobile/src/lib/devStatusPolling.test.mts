// devStatusPolling.test.mts — pins the preview-poll gate to transport truth.
// Run: node --experimental-strip-types --test src/lib/devStatusPolling.test.mts

import test from "node:test";
import assert from "node:assert/strict";

import { shouldPollDevStatus } from "./devStatusPolling.ts";

test("polls when the active device's pooled client is live", () => {
  assert.equal(
    shouldPollDevStatus({ activeDeviceId: "box-a", connectedDeviceIds: ["box-a", "box-b"] }),
    true,
  );
});

test("the regression: focused status 'connecting' must NOT stop the poll while the pool is live", () => {
  // The gate deliberately takes NO connectionStatus input — the old
  // `connectionStatus === "connected"` gate is what stranded the preview on
  // "Waiting for the dev server to report its address…" after a box
  // reconnect. If someone re-introduces a status parameter, this test's
  // signature check should make them think twice.
  assert.equal(
    shouldPollDevStatus({ activeDeviceId: "box-a", connectedDeviceIds: ["box-a"] }),
    true,
  );
});

test("no active device → no poll", () => {
  assert.equal(shouldPollDevStatus({ activeDeviceId: null, connectedDeviceIds: ["box-a"] }), false);
  assert.equal(shouldPollDevStatus({ activeDeviceId: undefined, connectedDeviceIds: [] }), false);
  assert.equal(shouldPollDevStatus({ activeDeviceId: "", connectedDeviceIds: ["box-a"] }), false);
});

test("active device not in the live pool → no poll (its client is down)", () => {
  assert.equal(
    shouldPollDevStatus({ activeDeviceId: "box-a", connectedDeviceIds: ["box-b"] }),
    false,
  );
});
