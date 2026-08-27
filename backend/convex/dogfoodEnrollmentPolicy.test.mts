import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dogfoodActionAllowed, dogfoodGenerationsToSupersede } from "./dogfoodEnrollmentPolicy.ts";

test("approval requires a pending installation with verified key proof", () => {
  assert.equal(dogfoodActionAllowed("pending", "approve", false), false);
  assert.equal(dogfoodActionAllowed("pending", "approve", true), true);
  assert.equal(dogfoodActionAllowed("active", "approve", true), false);
});

test("cancel is pending-only and revoke is active-only", () => {
  assert.equal(dogfoodActionAllowed("pending", "cancel", false), true);
  assert.equal(dogfoodActionAllowed("active", "cancel", true), false);
  assert.equal(dogfoodActionAllowed("active", "revoke", true), true);
  assert.equal(dogfoodActionAllowed("superseded", "revoke", true), false);
});

test("re-register supersedes prior generation of same slot, not another phone", () => {
  const rows = [
    { id: "mine-old", appId: "sfmg", registrationSlot: "mine", status: "active" as const },
    { id: "cousin", appId: "sfmg", registrationSlot: "cousin", status: "active" as const },
    { id: "other-app", appId: "other", registrationSlot: "mine", status: "active" as const },
  ];
  assert.deepEqual(dogfoodGenerationsToSupersede(rows, { id: "mine-new", appId: "sfmg", registrationSlot: "mine" }), ["mine-old"]);
});

test("all SDK consumers retain the live installation gate", () => {
  const auth = readFileSync(join(import.meta.dirname, "auth.ts"), "utf8");
  const feedback = readFileSync(join(import.meta.dirname, "feedbackWorkItems.ts"), "utf8");
  assert.match(auth, /Dogfood session tokens cannot be rotated/);
  assert.match(auth, /validateSdkTokenRowInternal\(ctx, args\.tokenHash\)/);
  assert.match(feedback, /validateSdkTokenRowInternal\(ctx, sdkTokenHash\)/);
});
