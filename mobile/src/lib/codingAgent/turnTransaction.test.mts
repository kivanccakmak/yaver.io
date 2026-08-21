import test from "node:test";
import assert from "node:assert/strict";

import { createTurnTransaction, restoreTurnSnapshot } from "./turnTransaction.ts";
import type { CodingSandbox, CodingSandboxEntry } from "./sandboxTools.ts";

function memorySandbox(initial: Record<string, string>): CodingSandbox & { dump(): Record<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    async readFile(path) {
      if (!files.has(path)) throw new Error("missing");
      return files.get(path)!;
    },
    async listFiles(): Promise<CodingSandboxEntry[]> {
      return [...files.entries()].map(([path, content]) => ({ path, isDirectory: false, size: content.length }));
    },
    async writeFile(path, content) { files.set(path, content); },
    async deleteFile(path) { files.delete(path); },
    dump: () => Object.fromEntries(files),
  };
}

test("undo restores modified/deleted files and removes files created by one turn", async () => {
  const base = memorySandbox({ "dirty.ts": "user work", "delete.ts": "keep after undo" });
  const turn = createTurnTransaction(base);
  await turn.sandbox.writeFile("dirty.ts", "agent edit 1");
  await turn.sandbox.writeFile("dirty.ts", "agent edit 2");
  await turn.sandbox.deleteFile("delete.ts");
  await turn.sandbox.writeFile("created.ts", "new");

  const saved = turn.snapshot();
  assert.equal(saved.entries.length, 3, "each path is captured only once");
  await restoreTurnSnapshot(base, saved);
  assert.deepEqual(base.dump(), { "dirty.ts": "user work", "delete.ts": "keep after undo" });
});

test("rollback is idempotent", async () => {
  const base = memorySandbox({ "a.ts": "before" });
  const turn = createTurnTransaction(base);
  await turn.sandbox.writeFile("a.ts", "after");
  await turn.rollback();
  await turn.rollback();
  assert.deepEqual(base.dump(), { "a.ts": "before" });
});
