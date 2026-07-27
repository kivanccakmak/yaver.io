// userSettingsGitRemote.test.mts — pins the git-remote sanitizer.
// Run: node --experimental-strip-types --test convex/userSettingsGitRemote.test.mts
//
// WHY THE SOURCE SCAN: Convex's runtime implements URL parsing but NOT the
// credential setters — `url.username = ""` throws "Not implemented: set
// username for URL". On 2026-07-27 that killed every runtime catalog sync and
// the dashboard's "Save default" with a stack trace in the runtime console.
// Node's URL DOES implement the setters, so a behavior test alone would stay
// green on the broken code; the scan is what fails if anyone reintroduces
// the setter pattern.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { sanitizeRuntimeGitRemote } from "./runtimeGitRemote.ts";

test("strips embedded credentials from HTTPS remotes", () => {
  assert.equal(
    sanitizeRuntimeGitRemote("https://user:ghp_token123@github.com/owner/repo.git"),
    "https://github.com/owner/repo.git",
  );
});

test("drops the fragment and trailing slash", () => {
  assert.equal(
    sanitizeRuntimeGitRemote("https://github.com/owner/repo/#readme"),
    "https://github.com/owner/repo",
  );
});

test("keeps query, host, and port intact", () => {
  assert.equal(
    sanitizeRuntimeGitRemote("https://git.example.com:8443/owner/repo.git?ref=main"),
    "https://git.example.com:8443/owner/repo.git?ref=main",
  );
});

test("passes SCP-style SSH remotes through unchanged", () => {
  assert.equal(
    sanitizeRuntimeGitRemote("git@github.com:owner/repo.git"),
    "git@github.com:owner/repo.git",
  );
});

test("drops unparseable token-like remotes instead of guessing", () => {
  assert.equal(sanitizeRuntimeGitRemote("https://%%%"), undefined);
  assert.equal(sanitizeRuntimeGitRemote("//user@host/repo"), undefined);
});

test("empty and missing values return undefined", () => {
  assert.equal(sanitizeRuntimeGitRemote(""), undefined);
  assert.equal(sanitizeRuntimeGitRemote(null), undefined);
  assert.equal(sanitizeRuntimeGitRemote(undefined), undefined);
});

test("runtimeGitRemote.ts never assigns URL credential/hash setters (Convex lacks them)", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "runtimeGitRemote.ts"),
    "utf8",
  );
  const banned = src.match(/\.\s*(username|password|hash)\s*=/g);
  assert.equal(
    banned,
    null,
    `URL setter assignment found (${String(banned)}) — Convex throws "Not implemented" on these; rebuild the URL from components instead.`,
  );
});
