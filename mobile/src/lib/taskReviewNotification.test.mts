import assert from "node:assert/strict";
import test from "node:test";

import { shouldNotifyTaskReview } from "./taskReviewNotification.ts";

test("notifies when a running task moves to review", () => {
  assert.equal(shouldNotifyTaskReview("running", "review"), true);
});

test("notifies when a queued task moves to review", () => {
  assert.equal(shouldNotifyTaskReview("queued", "review"), true);
});

test("does not notify for initial review rows", () => {
  assert.equal(shouldNotifyTaskReview(undefined, "review"), false);
});

test("does not notify for completed", () => {
  assert.equal(shouldNotifyTaskReview("running", "completed"), false);
});

test("does not notify when a review task is manually completed", () => {
  assert.equal(shouldNotifyTaskReview("review", "completed"), false);
});
