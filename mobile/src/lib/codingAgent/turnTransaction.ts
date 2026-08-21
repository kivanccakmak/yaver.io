// Reversible vibe-turn edits without touching Git history or the index. The
// wrapper records each path's original bytes on its first mutation. This keeps
// a user's pre-existing dirty tree intact and makes Undo Turn independent from
// commit/push policy.

import type { CodingSandbox } from "./sandboxTools";

export interface TurnSnapshotEntry {
  path: string;
  existed: boolean;
  content?: string;
}

export interface TurnSnapshot {
  entries: TurnSnapshotEntry[];
}

export interface TurnTransaction {
  sandbox: CodingSandbox;
  snapshot(): TurnSnapshot;
  rollback(): Promise<void>;
}

export interface TurnChangedFile {
  path: string;
  status: "added" | "modified" | "deleted";
}

export function createTurnTransaction(base: CodingSandbox): TurnTransaction {
  const originals = new Map<string, TurnSnapshotEntry>();

  const capture = async (path: string): Promise<void> => {
    if (originals.has(path)) return;
    try {
      originals.set(path, { path, existed: true, content: await base.readFile(path) });
    } catch {
      originals.set(path, { path, existed: false });
    }
  };

  const snapshot = (): TurnSnapshot => ({
    entries: [...originals.values()].map((entry) => ({ ...entry })),
  });

  return {
    sandbox: {
      readFile: (path) => base.readFile(path),
      listFiles: () => base.listFiles(),
      async writeFile(path, content) {
        await capture(path);
        await base.writeFile(path, content);
      },
      async deleteFile(path) {
        await capture(path);
        await base.deleteFile(path);
      },
    },
    snapshot,
    rollback: () => restoreTurnSnapshot(base, snapshot()),
  };
}

export async function restoreTurnSnapshot(base: CodingSandbox, snapshot: TurnSnapshot): Promise<void> {
  // Each path appears once and contains the pre-turn value, so ordering is not
  // significant. Restore existing files before removing turn-created files.
  for (const entry of snapshot.entries.filter((item) => item.existed)) {
    await base.writeFile(entry.path, entry.content ?? "");
  }
  for (const entry of snapshot.entries.filter((item) => !item.existed)) {
    await base.deleteFile(entry.path);
  }
}

export async function changedFilesForTurn(base: CodingSandbox, snapshot: TurnSnapshot): Promise<TurnChangedFile[]> {
  const changed: TurnChangedFile[] = [];
  for (const entry of snapshot.entries) {
    let current: string | undefined;
    try { current = await base.readFile(entry.path); } catch { current = undefined; }
    if (!entry.existed && current !== undefined) changed.push({ path: entry.path, status: "added" });
    else if (entry.existed && current === undefined) changed.push({ path: entry.path, status: "deleted" });
    else if (entry.existed && current !== entry.content) changed.push({ path: entry.path, status: "modified" });
  }
  return changed.sort((a, b) => a.path.localeCompare(b.path));
}
