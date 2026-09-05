import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isOptionalMoreToolEnabled, normalizeOptionalMoreTools } from "./moreOptionalTools";

describe("normalizeOptionalMoreTools", () => {
  test("keeps known tool ids in user order", () => {
    assert.deepEqual(normalizeOptionalMoreTools(["screw-cell", "robot-cell"]), [
      "screw-cell",
      "robot-cell",
    ]);
  });

  test("drops unknown, duplicate, and non-string values", () => {
    assert.deepEqual(normalizeOptionalMoreTools(["robot-cell", "unknown", "robot-cell", 42, null]), [
      "robot-cell",
    ]);
  });

  test("defaults non-arrays to an empty list", () => {
    assert.deepEqual(normalizeOptionalMoreTools(undefined), []);
    assert.deepEqual(normalizeOptionalMoreTools({}), []);
  });

  test("treats optional More tools as hidden until explicitly enabled", () => {
    assert.equal(isOptionalMoreToolEnabled(undefined, "robot-cell"), false);
    assert.equal(isOptionalMoreToolEnabled([], "screw-cell"), false);
    assert.equal(isOptionalMoreToolEnabled(["screw-cell"], "screw-cell"), true);
  });
});
