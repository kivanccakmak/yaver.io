import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const schema = readFileSync(join(root, "schema.ts"), "utf8");
const settings = readFileSync(join(root, "userSettings.ts"), "utf8");
const http = readFileSync(join(root, "http.ts"), "utf8");

test("auto-render consent persists end-to-end without an on-by-default seed", () => {
  assert.match(schema, /autoRenderVibing:\s*v\.optional\(v\.boolean\(\)\)/);
  assert.match(settings, /if \(args\.autoRenderVibing !== undefined\) patch\.autoRenderVibing = args\.autoRenderVibing/);
  assert.match(http, /autoRenderVibing:\s*body\.autoRenderVibing/);
  assert.doesNotMatch(schema, /autoRenderVibing[^\n]*default/i);
});
