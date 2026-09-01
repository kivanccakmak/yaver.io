import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

test("browser coordinator reports the RN-web target before loading Playwright", () => {
  const result = spawnSync(process.execPath, ["open-session.mjs"], {
    cwd: here,
    env: { ...process.env, MOBILE_WEB_URL: "" },
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /MOBILE_WEB_URL is required/);
  assert.doesNotMatch(result.stderr, /Cannot find package '@playwright\/test'/);
});
