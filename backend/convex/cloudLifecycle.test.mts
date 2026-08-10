import test from "node:test";
import assert from "node:assert/strict";

import {
  cloudWorkspaceCreditWeightForMachineType,
  includedAllowanceCoversStart,
  weightedIncludedCoverage,
  buildWakeCloudInit,
} from "./cloudLifecycle.js";

test("cloud workspace machine types map to standard-credit weights", () => {
  assert.equal(cloudWorkspaceCreditWeightForMachineType("standard"), 1);
  assert.equal(cloudWorkspaceCreditWeightForMachineType("heavy"), 2);
  assert.equal(cloudWorkspaceCreditWeightForMachineType("build"), 4);
  assert.equal(cloudWorkspaceCreditWeightForMachineType("cpu"), 4);
  assert.equal(cloudWorkspaceCreditWeightForMachineType("gpu"), 0);
});

test("weighted included coverage consumes one shared standard-credit pool", () => {
  const oneHour = 3600;
  const coverage = weightedIncludedCoverage({
    seconds: oneHour,
    usedStandardCreditSeconds: 0,
    includedStandardCreditSeconds: 120 * oneHour,
    creditWeight: 4,
  });
  assert.equal(coverage.coveredSeconds, oneHour);
  assert.equal(coverage.usedStandardCreditSeconds, 4 * oneHour);
  assert.equal(coverage.remainingStandardCreditSeconds, 116 * oneHour);
});

test("weighted included coverage partially covers when shared pool is low", () => {
  const coverage = weightedIncludedCoverage({
    seconds: 3600,
    usedStandardCreditSeconds: 119 * 3600,
    includedStandardCreditSeconds: 120 * 3600,
    creditWeight: 4,
  });
  assert.equal(coverage.coveredSeconds, 900);
  assert.equal(coverage.usedStandardCreditSeconds, 3600);
  assert.equal(coverage.remainingStandardCreditSeconds, 0);
});

test("included allowance start gate requires enough shared credits for one billable window", () => {
  assert.equal(
    includedAllowanceCoversStart({
      machineType: "standard",
      remainingStandardCreditSeconds: 3600,
    }),
    true,
  );
  assert.equal(
    includedAllowanceCoversStart({
      machineType: "heavy",
      remainingStandardCreditSeconds: 3600,
    }),
    false,
  );
  assert.equal(
    includedAllowanceCoversStart({
      machineType: "heavy",
      remainingStandardCreditSeconds: 7200,
    }),
    true,
  );
  assert.equal(
    includedAllowanceCoversStart({
      machineType: "build",
      remainingStandardCreditSeconds: 4 * 3600,
    }),
    true,
  );
  assert.equal(
    includedAllowanceCoversStart({
      machineType: "gpu",
      remainingStandardCreditSeconds: 24 * 3600,
    }),
    false,
  );
});

test("buildWakeCloudInit boots a fresh wake host (2026-08-10 wake blocker)", () => {
  // Regression: hetznerCreateFromImage used to send NO user-data, so a
  // vanilla wake host booted with nothing but Hetzner's default udev trigger —
  // no docker, no container, no agent → resumeHealthCheck burned its budget →
  // abandonWake parked again. Every volume-backed wake failed in prod.
  const init = buildWakeCloudInit({
    convexSite: "https://example.convex.site",
    machineId: "machine_ctr",
    hostname: "ctr.cloud.yaver.io",
    volumeId: "106577027",
    relayPassword: "relay-pass",
    image: "ghcr.io/kivanccakmak/yaver-cloud:latest",
  });
  // The volume must be mounted where the container expects it.
  assert.match(init, /scsi-0HC_Volume_106577027/);
  assert.match(init, /mount "\$dev" \/srv\/yaver\/state/);
  // A fresh host has no docker — the wake must install it.
  assert.match(init, /curl -fsSL https:\/\/get\.docker\.com \| sh/);
  // The plaintext machine token is never stored server-side: identity is
  // restored from the volume copy the provision path writes.
  assert.match(init, /cp \/srv\/yaver\/state\/\.yaver\/machine\.json \/etc\/yaver\/machine\.json/);
  // Same container + relay wiring as the provision path.
  assert.match(init, /docker run -d --name yaver --restart always/);
  assert.match(init, /RELAY_PASSWORD='relay-pass'/);
  assert.match(init, /-v \/etc\/yaver:\/etc\/yaver/);
  // dash-safe runcmd blocks (a failed "set -o pipefail" is a fatal special
  // builtin error), never the bare bash-ism as a block's first line.
  assert.match(init, /\n  - \|\n    set -eu\n/);
  assert.doesNotMatch(init, /\n  - \|\n    set -euo pipefail\n/);
});
