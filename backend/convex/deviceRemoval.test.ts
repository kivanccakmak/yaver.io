import assert from "node:assert/strict";
import { activeDeviceRows, isActiveDeviceRow } from "./deviceRemoval";

const active = { deviceId: "active" };
const removed = { deviceId: "removed", removed: true };
const revived = { deviceId: "revived", removed: false };

assert.equal(isActiveDeviceRow(active), true);
assert.equal(isActiveDeviceRow(removed), false, "a tombstone must never reach a user-facing surface");
assert.equal(isActiveDeviceRow(revived), true, "an explicit re-registration may revive the device");
assert.deepEqual(activeDeviceRows([active, removed, revived]).map((d) => d.deviceId), ["active", "revived"]);

console.log("deviceRemoval tests passed");
