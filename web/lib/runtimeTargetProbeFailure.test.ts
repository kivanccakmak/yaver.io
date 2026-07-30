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

test("relay credential failures repair relay credentials instead of routing to a runner", () => {
  for (const cause of [
    "Relay authentication failed. Check the relay password or sign in again. invalid relay password",
    'HTTP 401: {"ok":false,"code":"relay_password_invalid","error":"invalid relay password"}',
    "relay password missing — sign in again to fetch it",
  ]) {
    const plan = classifyRuntimeTargetProbeFailure(cause);
    assert.equal(plan.kind, "relay-auth");
    assert.equal(plan.retry, true);
    assert.equal(plan.useRunnerFallback, false);
    assert.equal(plan.showFixWithRunner, false, "relay credential refresh is deterministic, not an LLM task");
  }
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

test("unknown_verb from an older agent is version skew, never an LLM fix", () => {
  for (const cause of [
    'Renderer recovery failed: unknown verb "machine_repair"; call ops_verbs to list available verbs',
    "Machine repair is not supported by the connected agent [unknown_verb] — it predates the repair verb (needs agent 1.99.388+).",
  ]) {
    const plan = classifyRuntimeTargetProbeFailure(cause);
    assert.equal(plan.kind, "agent-verb-skew");
    assert.equal(plan.retry, true);
    assert.equal(plan.useRunnerFallback, false);
    assert.equal(plan.showFixWithRunner, false, "an LLM cannot add a verb to a released binary — update the agent instead");
  }
});

test("the probe-failure card must render the render-box connection check", () => {
  const src = readFileSync(join(webRoot, "components/dashboard/RuntimeLabView.tsx"), "utf8");
  assert.match(src, /probeRenderConnectivity/, "RuntimeLabView must probe render-box connectivity for the failure card");
  assert.match(src, /No connection to \{effectiveRenderBoxName\}/, "the failure card must state when no connection to the render box exists");
  assert.match(src, /Connection to \{effectiveRenderBoxName\}: OK/, "the failure card must state when the render box IS reachable");
});

test("the warden's resourcePressure signal has web consumers (signal-with-no-consumer guard)", () => {
  // Heartbeat → Convex → /devices/list already carry resourcePressure; these
  // surfaces are the consumers that make the signal exist for a user. A dark
  // box's last pressure report is the difference between "offline" and
  // "power-cycle it" (mac mini fork exhaustion, 2026-07-27/28).
  const runtimeSrc = readFileSync(join(webRoot, "components/dashboard/RuntimeLabView.tsx"), "utf8");
  assert.match(runtimeSrc, /resourcePressure/, "RuntimeLabView must read the render box's resourcePressure");
  assert.match(runtimeSrc, /process-table exhaustion/, "the failure card must name fork exhaustion when the box reported canFork=false");
  const devicesSrc = readFileSync(join(webRoot, "components/dashboard/DevicesView.tsx"), "utf8");
  assert.match(devicesSrc, /resourcePressure/, "DevicesView must render a pressure chip from resourcePressure");
});

test("ordinary target probe failures still route to the coding runner", () => {
  const plan = classifyRuntimeTargetProbeFailure("xcrun simctl failed");
  assert.equal(plan.kind, "other");
  assert.equal(plan.showFixWithRunner, true);
});

test("RuntimeLabView consumes the shared classifier instead of private relay regexes", () => {
  const src = readFileSync(join(webRoot, "components/dashboard/RuntimeLabView.tsx"), "utf8");
  assert.match(src, /classifyRuntimeTargetProbeFailure/, "RuntimeLabView must use the shared failure policy");
  assert.match(src, /repairRelayAndReloadTargets/, "RuntimeLabView must expose relay credential repair for relay-auth probe failures");
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
