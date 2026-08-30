import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const src = fs.readFileSync(new URL("../components/ShareComposeModal.tsx", import.meta.url), "utf8");

test("share compose falls back from live session delivery to a new task", () => {
  assert.match(src, /runnerSessionTurn\(id, comment\.trim\(\) \|\| title, null, 8000, images\)/);
  assert.match(src, /sendTaskToDevice\(id,\s*\{/);
});

test("share compose forwards deep-audit intent for shared screenshots", () => {
  assert.match(src, /const \[deepAudit, setDeepAudit\] = useState\(false\)/);
  assert.match(src, /askMode: deepAudit/);
  assert.match(src, /Deep audit on/);
});
