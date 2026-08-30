import assert from "node:assert/strict";
import test from "node:test";

import { injectPreviewPathRebase, shouldInjectPreviewPathRebase } from "./previewRebase.ts";

test("current agent keeps ownership of the scoped preview path", () => {
  const html = `<head><script data-yaver="yaver-preview-auth-shim"></script></head>`;
  assert.equal(shouldInjectPreviewPathRebase(html), false);
  assert.equal(injectPreviewPathRebase(html, "<script>outer-rebase</script>"), html);
});

test("legacy agent still receives the outer compatibility rebase", () => {
  const html = "<html><head data-theme=\"light\"></head><body></body></html>";
  assert.equal(shouldInjectPreviewPathRebase(html), true);
  assert.match(
    injectPreviewPathRebase(html, "<script>outer-rebase</script>"),
    /^<html><head data-theme="light"><script>outer-rebase<\/script>/,
  );
});
