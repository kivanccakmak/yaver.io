/**
 * preview-proxy.test.ts — `npx tsx lib/preview-proxy.test.ts`.
 * Pins the user-facing diagnosis for iframe proxy failures.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { previewProxyErrorMessage } from "./preview-proxy";

test("missing auth token is diagnosed as a dashboard cookie/proxy failure", () => {
  assert.match(
    previewProxyErrorMessage(401, '{"ok":false,"error":"missing auth token"}'),
    /dashboard auth cookie/,
  );
});

test("other proxy errors preserve their specific cause", () => {
  assert.equal(
    previewProxyErrorMessage(401, '{"ok":false,"error":"invalid relay password"}'),
    "invalid relay password",
  );
});

