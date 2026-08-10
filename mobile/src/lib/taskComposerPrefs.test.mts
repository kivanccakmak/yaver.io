import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  loadKeepLastProjectEnabled,
  loadLastTaskProject,
  loadLastTaskProjectFromConvex,
  loadMCPServersFromConvex,
  saveKeepLastProjectEnabled,
  saveLastTaskProject,
  saveLastTaskProjectToConvex,
  saveMCPServersToConvex,
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

test("Convex last-project sync degrades to null without a token or a row", async () => {
  // The full fetch round-trip cannot run here: the Convex helpers lazily
  // import ./auth, which pulls react-native/expo-secure-store — esbuild
  // cannot transform react-native/index.js, so the dynamic import throws and
  // the helpers no-op (by design: failures never block task creation). The
  // wire-shape + round-trip parity lives in web/lib/goalSlashCommandParity
  // .test.ts (real web helper logic against the SAME Convex fields), which
  // also asserts these mobile source markers. Here we pin the degradation:
  assert.equal(await loadLastTaskProjectFromConvex(null, "ubuntu-4gb"), null);
  assert.equal(await loadLastTaskProjectFromConvex("", "ubuntu-4gb"), null);
  await saveLastTaskProjectToConvex(null, { deviceId: "ubuntu-4gb", name: "medici.ai" }); // no throw
  await saveLastTaskProjectToConvex("tok", { deviceId: "", name: "x" }); // no throw (no deviceId)
});

test("Convex last-project sync source uses the canonical defaultRuntimeProject wire shape", () => {
  // Assert the mobile helpers target the SAME Convex fields as the web
  // helpers (defaultRuntimeProjectForDevice write / defaultRuntimeProjectByDevice
  // read) — the cross-surface memory contract. A drift here is caught by the
  // web parity test too; this keeps the pin next to the code.
  const source = readFileSync(new URL("./taskComposerPrefs.ts", import.meta.url), "utf8");
  assert.ok(source.includes("defaultRuntimeProjectForDevice"), "write must use defaultRuntimeProjectForDevice");
  assert.ok(source.includes("defaultRuntimeProjectByDevice"), "read must use defaultRuntimeProjectByDevice");
  assert.ok(source.includes('await import("./auth")'), "auth must be lazily imported (keeps this node test RN-free)");
});

test("Convex MCP sync degrades to null without a token or a row", async () => {
  // Same lazy-import contract as the project helpers (see the comment above).
  assert.equal(await loadMCPServersFromConvex(null, "ubuntu-4gb"), null);
  assert.equal(await loadMCPServersFromConvex("", "ubuntu-4gb"), null);
  assert.equal(await loadMCPServersFromConvex("tok", null), null);
  await saveMCPServersToConvex(null, { deviceId: "ubuntu-4gb" }); // no throw
  await saveMCPServersToConvex("tok", { deviceId: "" }); // no throw (no deviceId)
});

test("Convex MCP sync source uses the canonical mcpServers wire shape", () => {
  // The same mcpServersByDevice row the web dashboard (runtimeProjectSettings
  // .ts) and tvOS write — the cross-surface MCP memory contract (2026-08-10).
  const source = readFileSync(new URL("./taskComposerPrefs.ts", import.meta.url), "utf8");
  assert.ok(source.includes("mcpServersForDevice"), "write must use mcpServersForDevice");
  assert.ok(source.includes("mcpServersByDevice"), "read must use mcpServersByDevice");
  assert.ok(source.includes("includeYaverMcp"), "yaver doorway toggle must ride the same row");
});
