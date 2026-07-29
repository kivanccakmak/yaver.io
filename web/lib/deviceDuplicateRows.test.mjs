import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = join(process.cwd(), "web");

test("DevicesView hides duplicate needs-auth siblings only behind role-bearing rows", () => {
  const src = readFileSync(join(root, "components/dashboard/DevicesView.tsx"), "utf8");
  const duplicateBlock = src.slice(
    src.indexOf("function duplicateHostKey"),
    src.indexOf("function formatRunnerChipLabel"),
  );

  assert.match(
    duplicateBlock,
    /function duplicateHostKey\(device: Pick<Device, "isGuest" \| "platform" \| "name">/,
    "duplicate detection must key on hostname/platform, not agent version",
  );
  assert.match(
    src,
    /const hasRoleBearingSibling = group\.some\(\s*\(device\) => !device\.needsAuth && roleRank\(device\.id\) < 5,/s,
    "a duplicate sibling may be hidden only when a non-auth sibling carries a product role",
  );
  assert.match(
    src,
    /if \(device\.needsAuth && roleRank\(device\.id\) >= 5\) hidden\.add\(device\.id\);/,
    "the role-bearing row must remain visible even if an auth-recovery duplicate exists",
  );
  assert.doesNotMatch(
    duplicateBlock,
    /agentVersion/,
    "duplicate resolution must not prefer a row by agent version",
  );
});
