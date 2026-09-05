"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_TRANSIENT_LOAD_RETRIES,
  rendererLoadRetryDelay,
  shouldRetryRendererLoad,
} = require("../src/renderer-recovery-policy");

test("connection refusal is retried only within the bounded budget", () => {
  for (let attempts = 0; attempts < MAX_TRANSIENT_LOAD_RETRIES; attempts += 1) {
    assert.equal(shouldRetryRendererLoad({ code: -102, attempts }), true);
  }
  assert.equal(
    shouldRetryRendererLoad({ code: -102, attempts: MAX_TRANSIENT_LOAD_RETRIES }),
    false,
  );
});

test("renderer crashes and permanent navigation failures are not network retries", () => {
  assert.equal(shouldRetryRendererLoad({ code: -3, attempts: 0 }), false);
  assert.equal(shouldRetryRendererLoad({ code: -324, attempts: 0 }), false);
  assert.equal(shouldRetryRendererLoad({ code: "exception", attempts: 0 }), false);
});

test("network retry backoff is deterministic and capped", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map(rendererLoadRetryDelay),
    [500, 1_000, 2_000, 4_000, 4_000],
  );
});
