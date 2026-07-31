import { strict as assert } from "node:assert";
import { diagnoseRunnerFailure, runnerFailureFromTaskFailure } from "./runnerFailure";

const providerNotFound = diagnoseRunnerFailure({
  runner: "claude",
  model: "claude-opus-4-7",
  probe: "subprocess",
  output: "ProviderModelNotFoundError: ProviderModelNotFoundError",
  failedAt: 1_000,
});
assert.equal(providerNotFound?.kind, "model-not-found");
assert.equal(providerNotFound?.model, "claude-opus-4-7");
assert.equal(providerNotFound?.failedAt, 1_000);

const codexUnsupported = diagnoseRunnerFailure({
  runner: "codex",
  output: `ERROR: {"message":"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account."}`,
});
assert.equal(codexUnsupported?.kind, "model-not-supported");
assert.equal(codexUnsupported?.model, "gpt-5.3-codex");

const revoked = diagnoseRunnerFailure({
  runner: "claude",
  output: "Failed to authenticate. API Error: 401 OAuth access token has been revoked.",
  failedAt: 1785454320000,
});

assert.equal(revoked?.kind, "auth-revoked");
assert.equal(revoked?.runner, "claude");
assert.match(revoked?.title || "", /OAuth grant was revoked/);
assert.match(revoked?.remedy || "", /runner sign-in flow/);

const codexAuth = diagnoseRunnerFailure({
  runner: "codex",
  error: "Codex is installed but not authenticated on this machine.",
});

assert.equal(codexAuth?.kind, "auth");
assert.equal(codexAuth?.runner, "codex");

const bearerAuth = diagnoseRunnerFailure({
  runner: "claude",
  error: "invalid bearer token",
});
assert.equal(bearerAuth?.kind, "auth");

const subprocess = diagnoseRunnerFailure({
  runner: "claude",
  probe: "subprocess",
  error: "exit status 1",
});
assert.equal(subprocess?.kind, "subprocess");

assert.equal(diagnoseRunnerFailure({ error: "" }), null);

const typedRevoked = runnerFailureFromTaskFailure({
  kind: "runner_auth",
  code: "runner.claude.oauth_revoked",
  title: "Runner OAuth grant was revoked",
  reason: "Claude Code's OAuth access token has been revoked.",
  remedy: "Start the runner sign-in flow from this task, then run Test before retrying.",
  runnerId: "claude",
  model: "claude-sonnet-4",
  probe: "subprocess",
  detectedAt: "2026-07-30T12:00:00Z",
  fix: { type: "runner_browser_auth", runnerId: "claude", testAfter: true },
});
assert.equal(typedRevoked?.kind, "auth-revoked");
assert.equal(typedRevoked?.code, "runner.claude.oauth_revoked");
assert.equal(typedRevoked?.runner, "claude");
assert.equal(typedRevoked?.fix?.type, "runner_browser_auth");

console.log("ok runner failure auth plumbing");
