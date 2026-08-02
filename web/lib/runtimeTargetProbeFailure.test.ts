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

test("relay credential failures route to reconnect, never Fix-with-runner", () => {
  for (const cause of [
    "Relay authentication failed. Check the relay password or sign in again. invalid relay password",
    "Runtime target probe failed: too many invalid relay password attempts",
    '{"ok":false,"code":"relay_password_missing","error":"relay password missing — sign in again to fetch it"}',
  ]) {
    const plan = classifyRuntimeTargetProbeFailure(cause);
    assert.equal(plan.kind, "auth");
    assert.equal(plan.retry, true);
    assert.equal(plan.useRunnerFallback, false);
    assert.equal(plan.showFixWithRunner, false, "a runner task cannot fix a request that never reaches the box");
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

// ── project-missing: the 2026-08-02 cascade ────────────────────────────────
// Verbatim from the user's failed Vibing run. Before this classification the
// plan was `other` → showFixWithRunner: true, so a deterministic "that project
// is on the other box" question bought a real LLM run — which then died on an
// expired Codex token and a model the account cannot use.
test("a project missing on the render box never routes to a coding runner", () => {
  const plan = classifyRuntimeTargetProbeFailure(
    'no mobile project named "yaver / mobile" on this machine — check `yaver projects mobile`',
  );
  assert.equal(plan.kind, "project-missing");
  assert.equal(plan.showFixWithRunner, false,
    "an LLM cannot create a directory on a box it is not running on");
  assert.equal(plan.useRunnerFallback, true,
    "under a runner/render split the project usually IS on the runner box — that is the one-tap fix");
  assert.equal(plan.retry, false, "re-probing cannot conjure a missing directory");
});

test("the ASCII-hyphen form classifies too (terminals mangle the em dash)", () => {
  assert.equal(
    classifyRuntimeTargetProbeFailure(
      'no mobile project named "x" on this machine - check `yaver projects mobile`',
    ).kind,
    "project-missing",
  );
});

// NO FALSE REDS: a genuine build/compile failure MUST still reach the runner.
// Over-matching here would strand the user with no fix path at all, which is a
// worse product than the escalation we are trying to avoid.
test("a real build failure still offers Fix with runner", () => {
  const plan = classifyRuntimeTargetProbeFailure(
    "Metro bundler failed: SyntaxError in app/(tabs)/index.tsx line 42",
  );
  assert.equal(plan.kind, "other");
  assert.equal(plan.showFixWithRunner, true,
    "a compile error is exactly what a coding agent SHOULD fix — do not gate it");
});

test("an unrelated failure is untouched by the project-missing matcher", () => {
  assert.equal(classifyRuntimeTargetProbeFailure("ECONNRESET").kind, "other");
  assert.equal(classifyRuntimeTargetProbeFailure("").kind, "other");
});

// Ordering guard: a relay-credential failure that happens to mention a project
// must still classify as auth, not project-missing.
test("relay credential failures still win over the project matcher", () => {
  assert.equal(
    classifyRuntimeTargetProbeFailure(
      'relay_password_missing while probing project "x" on this machine — check it',
    ).kind,
    "auth",
  );
});
