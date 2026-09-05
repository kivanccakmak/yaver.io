import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSource = readFileSync(join(here, "schema.ts"), "utf8");
const moduleSource = readFileSync(join(here, "tmuxSessions.ts"), "utf8");
const httpSource = readFileSync(join(here, "http.ts"), "utf8");

test("tmuxRunnerSessions table exists with identifiers + lifecycle fields only", () => {
  assert.match(schemaSource, /tmuxRunnerSessions: defineTable\(/);
  for (const field of [
    "userId: v.id(\"users\")",
    "deviceId: v.string()",
    "sessionName: v.string()",
    "sessionId: v.optional(v.string())",
    "paneId: v.optional(v.string())",
    "runner: v.union(",
    "status: v.union(v.literal(\"open\"), v.literal(\"closed\"))",
    "paneCount: v.optional(v.number())",
    "firstSeenAt: v.number()",
    "lastSeenAt: v.number()",
    "closedAt: v.optional(v.number())",
  ]) {
    assert.ok(schemaSource.includes(field), `schema missing field/declaration: ${field}`);
  }
  // Privacy tripwire: the table must never grow a content-carrying field.
  for (const forbidden of ["preview", "currentPath", "title", "model", "prompt", "output"]) {
    const re = new RegExp(`tmuxRunnerSessions: defineTable\\([\\s\\S]*?\\n  \\)`); // eslint-disable-line no-control-regex
    const tableBlock = schemaSource.match(re)?.[0] ?? "";
    assert.ok(!tableBlock.includes(`${forbidden}:`), `tmuxRunnerSessions must not hold ${forbidden}`);
  }
});

test("tmuxRunnerSessions indexes cover user + device-session lookups", () => {
  assert.match(schemaSource, /\.index\("by_user", \["userId"\]\)/);
  assert.match(schemaSource, /\.index\("by_user_status", \["userId", "status"\]\)/);
  assert.match(schemaSource, /\.index\("by_device", \["deviceId"\]\)/);
  assert.match(schemaSource, /\.index\("by_device_session", \["deviceId", "sessionName"\]\)/);
});

test("syncTmuxSessions validates a privacy-safe arg shape", () => {
  // The sessionArgs validator names identifiers + lifecycle only.
  assert.match(moduleSource, /sessionArgs = v\.object\(\{/);
  assert.match(moduleSource, /sessionName: v\.string\(\)/);
  assert.match(moduleSource, /sessionId: v\.optional\(v\.string\(\)\)/);
  assert.match(moduleSource, /paneId: v\.optional\(v\.string\(\)\)/);
  assert.match(moduleSource, /status: tmuxSessionStatus/);
  assert.match(moduleSource, /runner: tmuxRunner/);
  // ... and nothing content-shaped sneaks in.
  for (const forbidden of ["v.string()", "preview", "currentPath", "title:", "prompt", "output"]) {
    const block = moduleSource.match(/const sessionArgs = v\.object\(\{[\s\S]*?\n\}\);/)?.[0] ?? "";
    if (forbidden === "v.string()") {
      // Six bounded identifiers may be strings: session/pane ids plus the
      // project/task hints. Runner/origin/status/input mode use unions. The
      // content-shaped names below remain the stronger privacy tripwire.
      const plainStringCount = (block.match(/v\.string\(\)/g) ?? []).length;
      assert.ok(plainStringCount <= 6, `sessionArgs has ${plainStringCount} plain string fields — identifiers only`);
    } else {
      assert.ok(!block.includes(forbidden), `sessionArgs must not carry ${forbidden}`);
    }
  }
});

test("syncTmuxSessions reconciles open/closed with sticky firstSeenAt", () => {
  // One-way close: a closed record must never reopen a row.
  assert.match(moduleSource, /status: "closed"/);
  // Reopen clears closedAt.
  assert.match(moduleSource, /closedAt: undefined/);
  // The agent's own firstSeenAt is preserved on patch.
  assert.match(moduleSource, /Keep the row's own firstSeenAt/);
  assert.match(moduleSource, /by_device_session/);
  // A successful exhaustive scan closes rows absent from the new snapshot,
  // while old/failed agents that omit fullSnapshot remain non-destructive.
  assert.match(moduleSource, /fullSnapshot: v\.optional\(v\.boolean\(\)\)/);
  assert.match(moduleSource, /if \(fullSnapshot\)/);
  assert.match(moduleSource, /openNames\.has\(row\.sessionName\)/);
  // Session-level closure must dominate stale pane-level open flags.
  assert.match(moduleSource, /closedPaneRecords\(s\.panes \?\? existing\.panes\)/);
  assert.match(moduleSource, /r\.status === "closed" \? "closed"/);
});

test("list query is tokenHash-authed and joins device identity", () => {
  assert.match(moduleSource, /export const list = query\(\{/);
  assert.match(moduleSource, /tokenHash: v\.string\(\)/);
  assert.match(moduleSource, /deviceId: v\.optional\(v\.string\(\)\)/);
  assert.match(moduleSource, /status: v\.optional\(tmuxSessionStatus\)/);
  assert.match(moduleSource, /by_deviceId/); // devices join
  assert.match(moduleSource, /deviceOnline/);
});

test("GET /tmux-sessions HTTP route is wired into the CORS allowlist", () => {
  assert.match(httpSource, /"\/tmux-sessions",/);
  assert.match(httpSource, /path: "\/tmux-sessions"/);
  assert.match(httpSource, /method: "GET"/);
  assert.match(httpSource, /api\.tmuxSessions\.list/);
  // Bearer-authed like every other client-facing route.
  assert.match(httpSource, /authHeader\?\.startsWith\("Bearer "\)/);
});

test("web tmux ledger client normalizes object responses before dashboard render", () => {
  const src = readFileSync(new URL("../../web/lib/tmux-sessions.ts", import.meta.url), "utf8");
  assert.match(src, /Array\.isArray\(data\)/);
  assert.match(src, /Array\.isArray\(data\?\.sessions\)/);
  assert.match(src, /return \[\];/);
});
