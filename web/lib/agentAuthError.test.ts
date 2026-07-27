/**
 * agentAuthError.test.ts — `npx tsx lib/agentAuthError.test.ts`.
 *
 * Pins the hoisted auth matcher (audit §6 item 4) two ways:
 *  1. behavior — the failure shapes the agent actually emits all match, and
 *     ordinary operation failures do not;
 *  2. structure — RuntimeLabView no longer carries a private copy, and the
 *     other dashboard views that used to drop raw 401s now import the shared
 *     matcher. Parity by construction: a drifted private copy fails here.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_AUTH_REMEDY, isAgentAuthErrorMessage } from "./agentAuthError";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("matches the agent's real auth-failure shapes", () => {
  const shapes = [
    "invalid token",
    "Agent reached, but its Convex session is expired — run `yaver auth` on the remote device",
    "session expired — sign in again",
    "agent auth expired",
    "HTTP 401",
    "HTTP 403",
    "401 Unauthorized",
    "Forbidden",
  ];
  for (const s of shapes) {
    assert.equal(isAgentAuthErrorMessage(s), true, `should match: ${s}`);
  }
});

test("does not match ordinary operation failures", () => {
  const shapes = [
    "Could not reach agent (direct, tunnel, or relay)",
    "dev server not available",
    "bandwidth limit exceeded: 120MB used of 100MB daily limit",
    "rate limit exceeded",
    "",
    null,
    undefined,
  ];
  for (const s of shapes) {
    assert.equal(isAgentAuthErrorMessage(s as string), false, `should NOT match: ${s}`);
  }
});

test("remedy names an action, not a status code", () => {
  assert.match(AGENT_AUTH_REMEDY, /yaver auth/);
  assert.match(AGENT_AUTH_REMEDY, /[Rr]econnect/);
});

test("dashboard views share the ONE matcher (no private copies)", () => {
  const views = [
    "components/dashboard/RuntimeLabView.tsx",
    "components/dashboard/ProjectsView.tsx",
    "components/dashboard/PreviewPane.tsx",
    "components/dashboard/VibeCodingView.tsx",
  ];
  for (const rel of views) {
    const src = readFileSync(join(root, rel), "utf8");
    assert.match(src, /from "@\/lib\/agentAuthError"/, `${rel} must import the shared matcher`);
    assert.doesNotMatch(
      src,
      /function isAgentAuthErrorMessage/,
      `${rel} must not define a private isAgentAuthErrorMessage`,
    );
  }
});
