import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "./secretRedaction.ts";

test("redacts exact provider and git secrets", () => {
  const out = redactSecrets("key=deep-secret token=github-secret", ["deep-secret", "github-secret"]);
  assert.equal(out.includes("deep-secret"), false);
  assert.equal(out.includes("github-secret"), false);
  assert.match(out, /REDACTED/);
});

test("redacts common token-shaped values and bearer headers", () => {
  const out = redactSecrets("Bearer ghp_1234567890abcdef token=sk-ant-1234567890abcdef");
  assert.equal(out.includes("ghp_"), false);
  assert.equal(out.includes("sk-ant-"), false);
});
