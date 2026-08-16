import assert from "node:assert/strict";
import test from "node:test";

import { machineRolesSaveErrorMessage } from "./machineRolesErrors";

test("machine role save error names owned-device route instead of backend stack", () => {
  const msg = machineRolesSaveErrorMessage(500, {
    error:
      "Uncaught Error: runnerDeviceId must refer to one of the caller's devices at assertMachineRolesOwned",
  });
  assert.equal(
    msg,
    "That route includes a machine this account does not own. Refresh Devices, pick one of your connected machines, then save again.",
  );
});

test("machine role save auth error names sign-in route", () => {
  assert.match(machineRolesSaveErrorMessage(401, { error: "Unauthorized" }), /Sign in again/);
});
