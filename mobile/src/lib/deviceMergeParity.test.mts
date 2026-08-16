// deviceMergeParity.test.mts — the three copies of the device-collapse rules
// must not drift.
//
// backend/convex, web/lib and mobile/src/lib each run the SAME collapse over
// their own snapshot, so each needs its own copy of the rule (Convex modules
// cannot be imported by the browser or by Metro). Copies drift silently and the
// drift only shows up as a user-visible flip-flop on someone's box — that is
// exactly how aliasShadowing.ts came to exist for an incident it then failed to
// fire on. This test reads all three files and asserts their CODE is identical
// (only the top-of-file "mirrored in …" comment may differ).
//
// Prove it by breaking it: change one copy's logic and watch this fail.
//
// Run: node --experimental-strip-types --test src/lib/deviceMergeParity.test.mts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", ".."); // mobile/src/lib -> repo root

/**
 * Everything from the first real statement onward. The header comment block is
 * deliberately per-surface (it names the OTHER copies), so it is the only part
 * allowed to differ.
 */
function code(path: string, firstStatement: string): string {
  const src = readFileSync(join(REPO, path), "utf8");
  const at = src.indexOf(firstStatement);
  assert.notEqual(at, -1, `${path}: expected to find ${JSON.stringify(firstStatement)}`);
  return src.slice(at);
}

const COPIES = {
  aliasShadowing: {
    firstStatement: "export const AGENT_LIVE_WINDOW_MS",
    paths: [
      "backend/convex/aliasShadowing.ts",
      "web/lib/aliasShadowing.ts",
      "mobile/src/lib/aliasShadowing.ts",
    ],
  },
  deviceIdentityMerge: {
    firstStatement: "import type { AliasPeer",
    paths: [
      "backend/convex/deviceIdentityMerge.ts",
      "web/lib/deviceIdentityMerge.ts",
      "mobile/src/lib/deviceIdentityMerge.ts",
    ],
  },
} as const;

for (const [name, spec] of Object.entries(COPIES)) {
  test(`${name}: all ${spec.paths.length} copies carry identical code`, () => {
    const [canonicalPath, ...rest] = spec.paths;
    const canonical = code(canonicalPath, spec.firstStatement);
    for (const path of rest) {
      assert.equal(
        code(path, spec.firstStatement),
        canonical,
        `${path} has drifted from ${canonicalPath} — port the change, do not fork the rule`,
      );
    }
  });
}

test("every copy still exports the symbols its surface calls", () => {
  // A copy that silently loses an export is the RN-web class of failure: `tsc`
  // is happy per-project and the call site throws at runtime, in a timer.
  const required: Record<string, string[]> = {
    "backend/convex/aliasShadowing.ts": ["aliasCollisionOutcome", "agentInstanceRelation"],
    "web/lib/aliasShadowing.ts": ["aliasCollisionOutcome", "agentInstanceRelation"],
    "mobile/src/lib/aliasShadowing.ts": ["aliasCollisionOutcome", "agentInstanceRelation"],
    "backend/convex/deviceIdentityMerge.ts": ["resolveIdentityMerge", "pickIdentityOwner"],
    "web/lib/deviceIdentityMerge.ts": ["resolveIdentityMerge", "pickIdentityOwner"],
    "mobile/src/lib/deviceIdentityMerge.ts": ["resolveIdentityMerge", "pickIdentityOwner"],
  };
  for (const [path, symbols] of Object.entries(required)) {
    const src = readFileSync(join(REPO, path), "utf8");
    for (const symbol of symbols) {
      assert.ok(
        src.includes(`export function ${symbol}`),
        `${path} no longer exports ${symbol}`,
      );
    }
  }
});
