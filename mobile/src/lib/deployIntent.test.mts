import assert from "node:assert/strict";
import test from "node:test";
import { makeDeployRequest, normalizeDeployStatus, planDeploy } from "./deployIntent";

test("plans Cloudflare direct API without claiming a remote runtime", () => {
  const plan = planDeploy({ projectId: "sfmg", targetId: "web", provider: "cloudflare-pages", execution: "direct-api", ref: "main" });
  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.equal(plan.requiresRemoteRuntime, false);
    assert.equal(plan.requiresConfirmation, true);
    assert.equal(plan.costRisk, "provider-usage");
  }
});

test("routes Convex to CI and reports CI cost risk", () => {
  const plan = planDeploy({ projectId: "sfmg", targetId: "backend", provider: "convex", execution: "provider-ci", workflow: "deploy-backend.yml", ref: "abc123" });
  assert.equal(plan.ok, true);
  if (plan.ok) assert.equal(plan.costRisk, "ci-minutes");
});

test("does not silently replace a missing remote box", () => {
  const result = planDeploy({ projectId: "sfmg", targetId: "ios", provider: "testflight", execution: "remote-box", ref: "main" });
  assert.deepEqual(result, {
    ok: false,
    code: "deploy_device_missing",
    message: "Select a connected remote box for this deploy.",
    route: { method: "GET", path: "/devices" },
  });
});

test("requires an existing workflow for provider CI", () => {
  const result = planDeploy({ projectId: "sfmg", targetId: "backend", provider: "github-actions", execution: "provider-ci", ref: "main" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "deploy_workflow_missing");
});

test("rejects direct Convex deploy from a phone-only lane", () => {
  const result = planDeploy({ projectId: "sfmg", targetId: "backend", provider: "convex", execution: "direct-api", ref: "main" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "deploy_phone_runtime_unsupported");
});

test("does not create an executable request without explicit confirmation", () => {
  const plan = planDeploy({ projectId: "sfmg", targetId: "web", provider: "cloudflare-pages", execution: "direct-api", ref: "main" });
  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.equal(makeDeployRequest(plan, "").ok, false);
    const request = makeDeployRequest(plan, "confirmation-123");
    assert.equal("ok" in request, false);
    if (!("ok" in request)) assert.equal(request.confirmationId, "confirmation-123");
  }
});

test("normalizes adapter status and drops unsafe response fields", () => {
  const plan = planDeploy({ projectId: "sfmg", targetId: "web", provider: "cloudflare-workers", execution: "direct-api", ref: "main" });
  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.deepEqual(normalizeDeployStatus(plan, {
      status: "in_progress",
      url: "https://preview.example.workers.dev",
      version: "v1",
      message: "building",
      secret: "must-not-pass",
    } as never), {
      operation: "deploy.status",
      idempotencyKey: plan.idempotencyKey,
      state: "running",
      provider: "cloudflare-workers",
      targetId: "web",
      url: "https://preview.example.workers.dev",
      version: "v1",
      message: "building",
    });
  }
});
