import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const here = new URL("./", import.meta.url);

test("preview stop is a rendered confirmation with verified completion", async () => {
  const dialog = await readFile(new URL("DevServerStopDialog.tsx", here), "utf8");
  const taskPreview = await readFile(new URL("DevPreview.tsx", here), "utf8");
  const projectsPreview = await readFile(new URL("../../app/(tabs)/apps.tsx", here), "utf8");

  assert.match(dialog, /Yes, stop/);
  assert.match(dialog, /Stopping preview…/);
  assert.match(dialog, /result\.verified === true/);
  assert.match(dialog, /client\.getDevServerStatus\(\)/);
  assert.match(dialog, /agent did not confirm that the preview process exited/i);

  for (const [name, source] of [["Tasks", taskPreview], ["Projects", projectsPreview]]) {
    assert.match(source, /<DevServerStopDialog/, `${name} must render the shared stop dialog`);
    assert.doesNotMatch(source, /Alert\.alert\("Stop (?:Serving Preview|Dev Server)"/, `${name} must not use RN-web's no-op Alert for stop`);
    assert.match(source, /Stopping…/, `${name} must narrate the in-flight stop`);
  }
});
