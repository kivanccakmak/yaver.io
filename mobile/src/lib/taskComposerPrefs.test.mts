import assert from "node:assert/strict";
import test from "node:test";

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  loadKeepLastProjectEnabled,
  loadLastTaskProject,
  saveKeepLastProjectEnabled,
  saveLastTaskProject,
} from "./taskComposerPrefs.ts";

const storage = ((AsyncStorage as any).default ?? AsyncStorage) as {
  clear: () => Promise<void>;
};

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  clear() {
    this.data.clear();
  }
}

(globalThis as any).window = { localStorage: new MemoryStorage() };
globalThis.localStorage = (globalThis as any).window.localStorage;

test("task composer keep-last-project defaults on and stores per device", async () => {
  await storage.clear();

  assert.equal(await loadKeepLastProjectEnabled(), true);
  await saveKeepLastProjectEnabled(false);
  assert.equal(await loadKeepLastProjectEnabled(), false);
  await saveKeepLastProjectEnabled(true);

  await saveLastTaskProject({
    deviceId: "ubuntu-4gb",
    name: "medici.ai",
    path: "/home/yaver/workspaces/medici.ai",
    branch: "main",
  });

  assert.equal(await loadLastTaskProject("other-box"), null);
  const saved = await loadLastTaskProject("ubuntu-4gb");
  assert.equal(saved?.name, "medici.ai");
  assert.equal(saved?.path, "/home/yaver/workspaces/medici.ai");
  assert.equal(saved?.branch, "main");
});
