import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MOBILE_APP_PALETTES,
  MOBILE_APP_GIT_PROVIDERS,
  buildMobileAppBuilderPrompt,
  chooseBuilderRemote,
  projectSlug,
} from "./mobileAppBuilderFlow.ts";

const devices = [
  { id: "secondary", name: "Beta box" },
  { id: "primary", name: "Alpha box" },
];

test("a connected primary remote wins over the active remote", () => {
  const chosen = chooseBuilderRemote(devices, new Set(["secondary", "primary"]), "primary", "secondary");
  assert.equal(chosen?.id, "primary");
});

test("project names become safe portable directory names", () => {
  assert.equal(projectSlug("  Café Companion!  "), "cafe-companion");
  assert.equal(projectSlug("***"), "mobile-app");
});

test("an unavailable primary is never presented as the build location", () => {
  const chosen = chooseBuilderRemote(devices, new Set(["secondary"]), "primary", "secondary");
  assert.equal(chosen?.id, "secondary");
  assert.equal(chooseBuilderRemote(devices, new Set(), "primary", "secondary"), null);
});

test("the chat handoff carries palette and inference rules instead of wizard questions", () => {
  const prompt = buildMobileAppBuilderPrompt(MOBILE_APP_PALETTES[0], "Alpha box");
  assert.match(prompt, /Alpha box/);
  assert.match(prompt, /#7557FF/);
  assert.match(prompt, /Do not turn this into a questionnaire/);
  assert.match(prompt, /Do not .*ask whether the app needs a backend/);
});

test("mobile initialization offers the three real Git destinations", () => {
  assert.deepEqual(MOBILE_APP_GIT_PROVIDERS.map((provider) => provider.id), ["yaver-git", "github", "gitlab"]);
});

test("initialization auto-submits a hidden kickoff into the selected project", async () => {
  const source = await readFile(new URL("../../app/(tabs)/newproject.tsx", import.meta.url), "utf8");
  assert.match(source, /autoSubmit:\s*"1"/);
  assert.match(source, /hideInitialPrompt:\s*"1"/);
  assert.match(source, /selectProject:\s*"1"/);
  assert.doesNotMatch(source, /openNew:\s*"1"/);
});
