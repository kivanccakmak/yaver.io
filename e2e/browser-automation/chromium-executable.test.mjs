import assert from "node:assert/strict";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveChromiumExecutable } from "./chromium-executable.mjs";

test("explicit executable override is accepted", async () => {
  const original = process.env.YAVER_CHROMIUM_PATH;
  const executable = process.execPath;
  await fs.access(executable, constants.X_OK);
  process.env.YAVER_CHROMIUM_PATH = executable;
  try {
    assert.equal(await resolveChromiumExecutable(), executable);
  } finally {
    if (original === undefined) delete process.env.YAVER_CHROMIUM_PATH;
    else process.env.YAVER_CHROMIUM_PATH = original;
  }
});

test("invalid explicit override fails with a named route", async () => {
  const original = process.env.YAVER_CHROMIUM_PATH;
  process.env.YAVER_CHROMIUM_PATH = path.join(os.tmpdir(), "yaver-missing-chromium-fixture");
  try {
    await assert.rejects(resolveChromiumExecutable(), /does not point to an available executable/);
  } finally {
    if (original === undefined) delete process.env.YAVER_CHROMIUM_PATH;
    else process.env.YAVER_CHROMIUM_PATH = original;
  }
});
