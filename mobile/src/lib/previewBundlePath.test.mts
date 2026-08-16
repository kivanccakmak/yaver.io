// previewBundlePath.test.mts — pins the agent-is-authority rule, the single
// legacy override, and the empty-url guard.
// Run: node --experimental-strip-types --test src/lib/previewBundlePath.test.mts

import test from "node:test";
import assert from "node:assert/strict";

import { previewBundlePath } from "./previewBundlePath.ts";

test("agent-reported bundleUrl wins when non-empty — even with a webPort", () => {
  // The regression this file exists for: the old code forced /dev-web/
  // whenever webPort was set, overriding a perfectly good agent report.
  assert.equal(
    previewBundlePath({ bundleUrl: "/dev-web/app/index.html", webPort: 9100 }),
    "/dev-web/app/index.html",
  );
  assert.equal(previewBundlePath({ bundleUrl: "/custom/", webPort: 9100 }), "/custom/");
});

test("legacy override: bundleUrl '/dev/' plus a webPort means the old-agent Metro lie", () => {
  assert.equal(previewBundlePath({ bundleUrl: "/dev/", webPort: 9100 }), "/dev-web/");
});

test("a direct '/dev/' serve with NO web sibling is honored as-is", () => {
  assert.equal(previewBundlePath({ bundleUrl: "/dev/", webPort: null }), "/dev/");
  assert.equal(previewBundlePath({ bundleUrl: "/dev/" }), "/dev/");
});

test("empty bundleUrl: webPort implies /dev-web/, otherwise NO url (never a '/dev/' default)", () => {
  assert.equal(previewBundlePath({ bundleUrl: "", webPort: 9100 }), "/dev-web/");
  assert.equal(previewBundlePath({ bundleUrl: "" }), "");
  assert.equal(previewBundlePath(null), "");
  assert.equal(previewBundlePath(undefined), "");
});
