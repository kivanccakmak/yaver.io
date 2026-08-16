import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("phone Tasks consumes the agent's structured task failure", () => {
  const src = fs.readFileSync(new URL("../../app/(tabs)/tasks.tsx", import.meta.url), "utf8");
  assert.match(src, /structured\s*=\s*task\.failure/);
  assert.match(src, /structured\?\.title/);
  assert.match(src, /structured\?\.remedy/);
});

test("mobile task wire type carries structured task failure", () => {
  const src = fs.readFileSync(new URL("./quic.ts", import.meta.url), "utf8");
  assert.match(src, /failure\?:\s*\{/);
  assert.match(src, /fix\?:\s*\{\s*type\?:\s*string/);
});

test("runner auth smart retry recognizes revoked OAuth text", () => {
  const src = fs.readFileSync(new URL("../components/ErrorMessage.tsx", import.meta.url), "utf8");
  assert.match(src, /oauth access token has been revoked/);
  assert.match(src, /token has been revoked/);
  assert.match(src, /please run \/login/);
});

test("spatial surface renders structured failure in task panes", () => {
  const src = fs.readFileSync(new URL("../../../web/app/spatial/page.tsx", import.meta.url), "utf8");
  assert.match(src, /compactTaskFailure/);
  assert.match(src, /task\.failure/);
});
