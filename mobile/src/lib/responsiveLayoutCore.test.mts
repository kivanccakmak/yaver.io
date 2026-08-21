import assert from "node:assert/strict";
import test from "node:test";
import { classifyResponsiveLayout } from "./responsiveLayoutCore.ts";

test("large portrait tablets stay portrait", () => {
  assert.equal(classifyResponsiveLayout(1024, 1366).layoutClass, "tablet-portrait");
  assert.equal(classifyResponsiveLayout(1152, 1848).layoutClass, "tablet-portrait");
});

test("the same tablets become split-capable only after rotation", () => {
  assert.equal(classifyResponsiveLayout(1366, 1024).layoutClass, "tablet-landscape");
  assert.equal(classifyResponsiveLayout(1848, 1152).layoutClass, "tablet-landscape");
});

test("a landscape phone remains a phone", () => {
  const result = classifyResponsiveLayout(932, 430);
  assert.equal(result.isLandscape, true);
  assert.equal(result.isTablet, false);
  assert.equal(result.layoutClass, "phone");
});

test("the closed-loop tablet profiles hit opposite layout trees", () => {
  assert.equal(classifyResponsiveLayout(810, 1080).layoutClass, "tablet-portrait");
  assert.equal(classifyResponsiveLayout(1024, 640).layoutClass, "tablet-landscape");
});
