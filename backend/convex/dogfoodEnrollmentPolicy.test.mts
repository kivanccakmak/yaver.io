import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dogfoodActionAllowed,
  dogfoodGenerationsToSupersede,
  dogfoodInstallationAuthorized,
  dogfoodControlActionMessage,
  dogfoodTesterAssigned,
  dogfoodTesterBinding,
  normalizeDogfoodTesterEmail,
} from "./dogfoodEnrollmentPolicy.ts";

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

test("Dogfood access resolves the global app and rejects narrow sessions", () => {
  const auth = readFileSync(join(import.meta.dirname, "auth.ts"), "utf8");
  const http = readFileSync(join(import.meta.dirname, "http.ts"), "utf8");
  assert.match(auth, /session\.scope && session\.scope !== "full"/);
  assert.match(auth, /withIndex\("by_app"/);
  assert.match(auth, /dogfoodInstallationAuthorized/);
  assert.match(http, /path: "\/dogfood\/access"/);
});

test("an approved tester is authorized without owning the app", () => {
  assert.equal(dogfoodInstallationAuthorized({
    appEnabled: true,
    appOwnerUserId: "sfmg-owner",
    sessionUserId: "cousin",
    installationStatus: "active",
    testerUserId: "cousin",
    testerAssigned: true,
  }), true);
});

test("owner-managed app assignment accepts exact account or an unbound normalized email", () => {
  assert.equal(normalizeDogfoodTesterEmail(" Serhat@Example.COM "), "serhat@example.com");
  assert.equal(dogfoodTesterAssigned({
    appOwnerUserId: "owner",
    sessionUserId: "cousin",
    sessionEmail: "serhat@example.com",
    assignments: [{ status: "active", testerEmail: "serhat@example.com" }],
  }), true);
  assert.equal(dogfoodTesterAssigned({
    appOwnerUserId: "owner",
    sessionUserId: "owner",
    sessionEmail: "owner@example.com",
    assignments: [],
  }), true);
});

test("a bound assignment cannot be reused by a later account with the same email", () => {
  assert.equal(dogfoodTesterAssigned({
    appOwnerUserId: "owner",
    sessionUserId: "attacker",
    sessionEmail: "serhat@example.com",
    assignments: [{ status: "active", testerEmail: "serhat@example.com", testerUserId: "cousin" }],
  }), false);
  assert.equal(dogfoodTesterBinding("cousin", "attacker"), "cousin");
  assert.equal(dogfoodTesterBinding(undefined, "cousin"), "cousin");
});

test("revoked or absent assignment cannot authorize an otherwise active installation", () => {
  assert.equal(dogfoodInstallationAuthorized({
    appEnabled: true,
    appOwnerUserId: "owner",
    sessionUserId: "cousin",
    installationStatus: "active",
    testerUserId: "cousin",
    testerAssigned: false,
  }), false);
});

test("owner status never replaces exact-phone enrollment", () => {
  assert.equal(dogfoodInstallationAuthorized({
    appEnabled: true,
    appOwnerUserId: "sfmg-owner",
    sessionUserId: "sfmg-owner",
  }), false);
});

test("another account cannot reuse an approved phone key", () => {
  assert.equal(dogfoodInstallationAuthorized({
    appEnabled: true,
    appOwnerUserId: "sfmg-owner",
    sessionUserId: "attacker",
    installationStatus: "active",
    testerUserId: "cousin",
    testerAssigned: true,
  }), false);
});

test("control-device action proof binds phone, installation, action, and time", () => {
  assert.equal(dogfoodControlActionMessage({
    deviceId: "mobile_1234567890abcdef",
    installationDocId: "install-doc",
    action: "approve",
    signedAt: 1234,
  }), "yaver-dogfood-control-action-v1\nmobile_1234567890abcdef\ninstall-doc\napprove\n1234");
});
