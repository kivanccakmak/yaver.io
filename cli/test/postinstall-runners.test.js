"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "postinstall.js"), "utf8");

test("global bootstrap names all three official first-class runner packages", () => {
  assert.match(source, /@anthropic-ai\/claude-code/);
  assert.match(source, /@openai\/codex/);
  assert.match(source, /opencode-ai/);
});

test("PowerShell/global Windows installs bootstrap runners before returning", () => {
  const windowsBranch = source.slice(source.lastIndexOf('if (process.platform === "win32") {'));
  assert.match(windowsBranch, /installMissingCodingRunners\(\)/);
  assert.match(windowsBranch, /setupMCPForInstalledRunners\(\)/);
  assert.match(source, /where\.exe/);
  assert.match(source, /process\.platform === "win32" \? prefix/);
});

test("desktop companion bootstrap is verified, best-effort, and reversible", () => {
  assert.match(source, /desktop\(\["install", "--no-open"\]\)/);
  assert.match(source, /YAVER_SKIP_POSTINSTALL_DESKTOP/);
  assert.match(source, /installedDesktopCandidates/);
});
