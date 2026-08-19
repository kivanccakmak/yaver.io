import assert from "node:assert/strict";
import { deviceRemovalPolicy } from "./deviceRemovalPolicy";

assert.equal(deviceRemovalPolicy({ hosting: "yaver-hosted" }), "cloud-decommission");
assert.equal(deviceRemovalPolicy({ managed: true }), "cloud-decommission", "legacy managed rows stay safe");
assert.equal(deviceRemovalPolicy({ hosting: "byo" }), "account-forget", "BYO never enters snapshot/provider flow");
assert.equal(deviceRemovalPolicy({ hosting: "byo", managed: true }), "account-forget", "explicit BYO provenance wins over the legacy managed bit");
assert.equal(deviceRemovalPolicy({ hosting: "self-hosted" }), "account-forget");
assert.equal(deviceRemovalPolicy({}), "account-forget", "old unclassified devices default to non-destructive removal");

console.log("deviceRemovalPolicy tests passed");
