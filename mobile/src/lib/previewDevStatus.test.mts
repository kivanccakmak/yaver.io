import test from "node:test";
import assert from "node:assert/strict";
import { reconcilePreviewDevStatus, usablePreviewDevStatus } from "./previewDevStatus.ts";

const running = {
  framework: "expo", running: true, serving: true, servingLabel: "Serving expo preview",
  port: 8081, webPort: 8082, bundleUrl: "/dev-web/", workDir: "/workspace/sfmg",
} as any;
const fetchFailure = {
  framework: "", running: false, serving: false, servingLabel: "Agent route is unreachable",
  port: 0, bundleUrl: "", error: "Failed to fetch", hotReload: false,
} as any;

test("an open preview keeps its last good route across a transient status failure", () => {
  assert.equal(reconcilePreviewDevStatus(running, fetchFailure, true), running);
  assert.equal(reconcilePreviewDevStatus(running, null, true), running);
});

test("a real stopped status tears down an open preview", () => {
  const stopped = { ...running, running: false, serving: false, building: false };
  assert.equal(reconcilePreviewDevStatus(running, stopped, true), null);
});

test("a closed preview still surfaces the status failure", () => {
  assert.equal(reconcilePreviewDevStatus(running, fetchFailure, false), fetchFailure);
});

test("Open in Yaver falls back to the measured running route", () => {
  assert.equal(usablePreviewDevStatus(fetchFailure, running), running);
});

test("a fresh active status always wins", () => {
  const fresh = { ...running, webPort: 9000 };
  assert.equal(usablePreviewDevStatus(fresh, running), fresh);
});
