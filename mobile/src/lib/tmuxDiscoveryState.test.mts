import assert from "node:assert/strict";
import test from "node:test";

import { tmuxDiscoveryView } from "./tmuxDiscoveryState.ts";

test("a failed tmux scan is not rendered as an empty session list", () => {
  assert.equal(tmuxDiscoveryView({ loading: false, error: "timed out", count: 0 }), "error");
});

test("loading settles into empty or ready only after the operation answers", () => {
  assert.equal(tmuxDiscoveryView({ loading: true, error: null, count: 0 }), "loading");
  assert.equal(tmuxDiscoveryView({ loading: true, error: null, count: 2 }), "ready");
  assert.equal(tmuxDiscoveryView({ loading: false, error: null, count: 0 }), "empty");
  assert.equal(tmuxDiscoveryView({ loading: false, error: null, count: 2 }), "ready");
});
