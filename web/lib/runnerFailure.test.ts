import { strict as assert } from "node:assert";
import { diagnoseRunnerFailure } from "./runnerFailure";

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

console.log("ok runner failure auth plumbing");
