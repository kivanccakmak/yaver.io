import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyRuntimeTargetProbeFailure,
  RELAY_DEVICE_NOT_CONNECTED_CODE,
  RELAY_DEVICE_NOT_CONNECTED_REASON,
} from "./runtimeTargetProbeFailure";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("relay-presence failures route to retry plus render-machine fallback", () => {
  for (const cause of [
    "device not connected to relay",
    `${RELAY_DEVICE_NOT_CONNECTED_CODE}: no tunnel`,
    `${RELAY_DEVICE_NOT_CONNECTED_REASON}: no tunnel`,
  ]) {
    const plan = classifyRuntimeTargetProbeFailure(cause);
    assert.equal(plan.kind, "relay-presence");
    assert.equal(plan.retry, true);
    assert.equal(plan.useRunnerFallback, true);
    assert.equal(plan.showFixWithRunner, false);
  }
});

test("relay route configuration failures are deterministic, not LLM fixes", () => {
  const plan = classifyRuntimeTargetProbeFailure("render is only reachable over a relay but no relay URL is configured");
  assert.equal(plan.kind, "relay-route");
  assert.equal(plan.retry, true);
  assert.equal(plan.useRunnerFallback, true);
  assert.equal(plan.showFixWithRunner, false);
});

test("machine role doctor render failures are deterministic repair routes", () => {
  for (const cause of [
    // Stable-code form emitted by ensureMachineRolesReady — codes, not prose,
    // are the contract; the prose form is the legacy fallback.
    "targets blocked [render_unreachable]: render box has no reachable transport",
    "targets blocked: render machine example-render is not reachable: no transport reaches it",
  ]) {
    const plan = classifyRuntimeTargetProbeFailure(cause);
    assert.equal(plan.kind, "relay-presence");
    assert.equal(plan.retry, true);
    assert.equal(plan.useRunnerFallback, true);
    assert.equal(plan.showFixWithRunner, false);
  }
});

test("an unreachable runner never routes to Fix-with-runner or render-on-runner", () => {
  for (const cause of [
    "web preview blocked [runner_unreachable]: runner box has no reachable transport",
    "runner machine example-runner is not reachable through any transport",
  ]) {
    const plan = classifyRuntimeTargetProbeFailure(cause);
    assert.equal(plan.kind, "relay-presence");
    assert.equal(plan.retry, true);
    assert.equal(plan.useRunnerFallback, false, "the runner is the offline box — rendering on it cannot work");
    assert.equal(plan.showFixWithRunner, false, "a coding agent on a dead box cannot fix the dead box");
  }
});

test("ordinary target probe failures still route to the coding runner", () => {
  const plan = classifyRuntimeTargetProbeFailure("xcrun simctl failed");
  assert.equal(plan.kind, "other");
  assert.equal(plan.showFixWithRunner, true);
});

test("RuntimeLabView consumes the shared classifier instead of private relay regexes", () => {
  const src = readFileSync(join(webRoot, "components/dashboard/RuntimeLabView.tsx"), "utf8");
  assert.match(src, /classifyRuntimeTargetProbeFailure/, "RuntimeLabView must use the shared failure policy");
  assert.doesNotMatch(
    src,
    /device not connected to relay\|only reachable over a relay/,
    "RuntimeLabView must not reintroduce the old inline relay regex branch",
  );
});

test("RuntimeLabView checks machine-role reachability before render operations", () => {
  const src = readFileSync(join(webRoot, "components/dashboard/RuntimeLabView.tsx"), "utf8");

  assert.match(src, /callOps\("machine_roles_doctor"/, "RuntimeLabView must consume the backend role doctor");
  assert.match(src, /callOps\("machine_repair"/, "RuntimeLabView must expose the backend repair route");
  assert.match(src, /ensureMachineRolesReady\("targets"\)/, "Load Targets must block before probing an unreachable render box");
  assert.match(src, /ensureMachineRolesReady\("web preview"\)/, "Web preview launch must block before using an unreachable render box");
});
