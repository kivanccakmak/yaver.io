"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DesktopLog, redactDesktopLog } = require("../src/desktop-log");

test("desktop log redacts credentials and auth query material", () => {
  const redacted = redactDesktopLog("Authorization: Bearer abc.def token=hello&__rp=relay password=hunter2");
  assert.doesNotMatch(redacted, /abc\.def|hello|relay|hunter2/);
  assert.match(redacted, /\[REDACTED\]/);
});

test("desktop log rotates bounded files and reports queue drops", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaver-desktop-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = new DesktopLog({ directory: dir, maxBytes: 220, maxFiles: 3, maxQueueBytes: 180, flushMs: 60_000 });
  for (let i = 0; i < 20; i += 1) log.write("info", "test", `row-${i}-${"x".repeat(50)}`);
  log.flush();
  assert.match(fs.readFileSync(log.filePath, "utf8"), /log_queue_dropped/);
  for (let i = 0; i < 8; i += 1) { log.write("info", "rotate", `row-${i}-${"y".repeat(50)}`); log.flush(); }
  log.close();
  const files = fs.readdirSync(dir).filter((name) => name.startsWith("yaver-desktop.log"));
  assert.ok(files.length <= 3, `bounded files: ${files.join(", ")}`);
  const text = files.map((name) => fs.readFileSync(path.join(dir, name), "utf8")).join("\n");
  assert.match(text, /rotate/);
});
