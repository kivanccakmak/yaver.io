import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSource = readFileSync(join(here, "schema.ts"), "utf8");
const moduleSource = readFileSync(join(here, "agentTaskSnapshots.ts"), "utf8");
const httpSource = readFileSync(join(here, "http.ts"), "utf8");

test("agent task snapshots expose identity and lifecycle only", () => {
  const table = schemaSource.match(/agentTaskSnapshots: defineTable\(\{[\s\S]*?\n  \}\)[\s\S]*?\.index\("by_device"/)?.[0] ?? "";
  for (const field of ["userId:", "deviceId:", "observedAt:", "taskId:", "yaverSessionId:", "hostKind:", "status:", "updatedAt:"]) {
    assert.ok(table.includes(field), `snapshot schema missing ${field}`);
  }
  for (const forbidden of ["title:", "prompt:", "description:", "output:", "source:", "path:", "project:", "model:"]) {
    assert.ok(!table.includes(forbidden), `snapshot schema must not hold ${forbidden}`);
    assert.ok(!moduleSource.includes(`${forbidden} v.`), `snapshot mutation must not accept ${forbidden}`);
  }
});

test("host kind is a closed, non-sensitive enum", () => {
  for (const kind of ["terminal_tmux", "desktop_gui", "runner_process"]) {
    assert.ok(moduleSource.includes(`v.literal("${kind}")`), `missing host kind ${kind}`);
  }
});

test("snapshot sync is one bounded row per owned device", () => {
  assert.match(moduleSource, /resolveUser\(ctx\)/);
  assert.match(moduleSource, /Device ownership mismatch/);
  assert.match(moduleSource, /args\.tasks\.slice\(0, 200\)/);
  assert.match(moduleSource, /withIndex\("by_device"/);
  assert.match(moduleSource, /observedAt: Date\.now\(\)/);
});

test("GET task-snapshots is bearer authenticated and wired", () => {
  assert.match(httpSource, /path: "\/task-snapshots"/);
  assert.match(httpSource, /authHeader\?\.startsWith\("Bearer "\)/);
  assert.match(httpSource, /api\.agentTaskSnapshots\.list/);
});
