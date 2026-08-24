import test from "node:test";
import assert from "node:assert/strict";

import { isOwner, isOwnerEmail, ownerEmails } from "./ownerAllowlist.js";

test("owner email allowlist accepts the plural cloud-preview spelling", () => {
  const env = { CLOUD_PREVIEW_OWNER_EMAILS: " Owner@Example.com, second@example.com " };
  assert.equal(isOwnerEmail("owner@example.com", env), true);
  assert.equal(isOwnerEmail("missing@example.com", env), false);
});

test("owner email allowlists are unioned instead of shadowing each other", () => {
  const env = {
    CLOUD_PREVIEW_OWNER_EMAIL: "stale@example.com",
    CLOUD_PREVIEW_OWNER_EMAILS: "owner@example.com",
    YAVER_CLOUD_PREVIEW_EMAILS: "linked@example.com",
  };
  assert.deepEqual(ownerEmails(env), ["stale@example.com", "owner@example.com", "linked@example.com"]);
  assert.equal(isOwnerEmail("owner@example.com", env), true);
  assert.equal(isOwnerEmail("linked@example.com", env), true);
});

test("combined owner gate remains fail-closed and supports canonical user id", () => {
  assert.equal(isOwner("owner@example.com", "user-1", {}), false);
  assert.equal(isOwner(null, "user-1", { CLOUD_PREVIEW_OWNER_USER_IDS: "user-1" }), true);
});
