/**
 * use-auth.test.ts — `npx tsx lib/use-auth.test.ts`.
 * Pins the browser cookie shape used by server-side dashboard routes.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { yaverAuthTokenCookie } from "./use-auth";

test("auth token cookie is scoped for same-origin dashboard routes", () => {
  assert.equal(
    yaverAuthTokenCookie("tok_123", 123),
    "yaver_auth_token=tok_123; path=/; max-age=123; secure; samesite=lax",
  );
});

test("auth token cookie is not Secure on localhost HTTP dev server", () => {
  const prior = (globalThis as any).window;
  (globalThis as any).window = { location: { protocol: "http:", hostname: "localhost" } };
  try {
    assert.equal(
      yaverAuthTokenCookie("tok_123", 123),
      "yaver_auth_token=tok_123; path=/; max-age=123; samesite=lax",
    );
  } finally {
    if (prior === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = prior;
  }
});
