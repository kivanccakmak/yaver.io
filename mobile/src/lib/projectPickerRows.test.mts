import assert from "node:assert/strict";
import test from "node:test";

import { visibleProjectPickerRows } from "./projectPickerRows.ts";

const projects = [
  { name: "talos", path: "/root/Workspace/talos", branch: "main" },
  { name: "todo-rn", path: "/root/Workspace/todo-rn", framework: "expo" },
  { name: "yaver.io", path: "/root/Workspace/yaver.io", branch: "codex/mobile-picker" },
];

test("remembered project is the first picker row without changing the remaining order", () => {
  const rows = visibleProjectPickerRows(projects, "/root/Workspace/yaver.io", "");
  assert.deepEqual(rows.map((row) => row.name), ["yaver.io", "talos", "todo-rn"]);
});

test("project search matches names, paths, branches, and frameworks", () => {
  assert.deepEqual(visibleProjectPickerRows(projects, "", "yaver").map((row) => row.name), ["yaver.io"]);
  assert.deepEqual(visibleProjectPickerRows(projects, "", "expo").map((row) => row.name), ["todo-rn"]);
  assert.deepEqual(visibleProjectPickerRows(projects, "", "codex/mobile").map((row) => row.name), ["yaver.io"]);
});

test("a selected project remains first inside filtered results", () => {
  const sameFramework = projects.map((project) => ({ ...project, framework: "workspace" }));
  const rows = visibleProjectPickerRows(sameFramework, "/root/Workspace/yaver.io", "workspace");
  assert.equal(rows[0]?.name, "yaver.io");
  assert.equal(rows.length, 3);
});
