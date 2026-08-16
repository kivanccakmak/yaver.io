/**
 * approveFailureParity.test.ts — `npx tsx lib/approveFailureParity.test.ts`.
 *
 * web/lib/approveFailureMessage.ts and mobile/src/lib/approveFailureMessage.ts
 * are the same function twice, because web cannot import from mobile/. Two
 * copies of one classifier is exactly the shape that has bitten this codebase
 * before: mobile already carried THREE different relay-auth matchers, none a
 * superset of the others, each drifting quietly because nothing compared them.
 *
 * So compare them. If the phone and the browser ever disagree about why a code
 * was refused, the user gets two stories about one machine — on the screen
 * whose entire job is un-stranding that machine.
 *
 * Prove it by breaking it: change one word in either copy and rerun.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const body = (p: string) => {
  const s = readFileSync(join(root, p), "utf8");
  const i = s.indexOf("export function approveFailureMessage");
  assert.ok(i > 0, `${p} no longer exports approveFailureMessage`);
  return s.slice(i).trim();
};

test("the web and mobile classifiers are the same function", () => {
  assert.equal(
    body("web/lib/approveFailureMessage.ts"),
    body("mobile/src/lib/approveFailureMessage.ts"),
    "the two approveFailureMessage copies have drifted — a user who tries the phone " +
      "and then the browser would be told two different things about one code",
  );
});
