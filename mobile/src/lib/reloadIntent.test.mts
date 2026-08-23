// Run: npx tsx src/lib/reloadIntent.test.mts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseReloadIntent } from "./reloadIntent.ts";

test("named reload preserves the project token", () => {
  assert.deepEqual(parseReloadIntent("reload sfmg"), { projectName: "sfmg" });
  assert.deepEqual(parseReloadIntent("please fast reload sfmg!"), { projectName: "sfmg" });
});

test("unnamed reload remains an active-surface command", () => {
  assert.deepEqual(parseReloadIntent("reload"), {});
  assert.deepEqual(parseReloadIntent("refresh the preview"), {});
});

test("coding prompts that merely mention reload are not intercepted", () => {
  assert.equal(parseReloadIntent("reload the user list after delete"), null);
  assert.equal(parseReloadIntent("fix the reload bug"), null);
});

test("named project survives composer -> client -> reload-app wiring", () => {
  const tasks = readFileSync(new URL("../../app/(tabs)/tasks.tsx", import.meta.url), "utf8");
  const client = readFileSync(new URL("./quic.ts", import.meta.url), "utf8");
  const webRuntime = readFileSync(new URL("../../../web/components/dashboard/RuntimeLabView.tsx", import.meta.url), "utf8");

  assert.match(tasks, /triggerHermesReload\(reloadIntent\.projectName\)/);
  assert.match(tasks, /projectName:\s*reloadIntent\.projectName/);
  assert.match(tasks, /namedReloadExecutorRef\.current\?\.\(pending\.projectName\)/);
  assert.match(tasks, /projectName:\s*explicitProjectName\s*\|\|/);
  assert.match(client, /opts\?\.projectName\s*\?\s*\{\s*projectName:\s*opts\.projectName\s*\}/);
  assert.match(client, /opts\?\.platform\s*\?\s*\{\s*platform:\s*opts\.platform\s*\}/);
  // RN-web is the real mobile browser lane. It must build the named project,
  // never fall through to the native loader or refresh a global active bundle.
  assert.match(tasks, /Platform\.OS === "web" && explicitProjectName/);
  assert.match(tasks, /buildWebJSBundle\(\{[\s\S]*?projectName:\s*explicitProjectName/);
  assert.match(client, /target:\s*"web-js-bundle"/);
  // The dashboard's independent browser implementation carries the same
  // project pin, guarding the cross-surface half of the incident.
  assert.match(webRuntime, /buildWebJSBundle\(\{[\s\S]*?projectName:\s*selectedProject\.name,[\s\S]*?projectPath:\s*selectedProject\.path/);
});
