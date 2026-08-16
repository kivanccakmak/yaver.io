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

// ── Real provider failure shapes (researched 2026-08-02) ───────────────────
// Every string below is a shape Claude Code / OpenCode actually emit. The
// point of each case is the SAME: none of these is a broken Yaver credential,
// so none may route the user into a sign-in flow that cannot fix them.

const billing = diagnoseRunnerFailure({
  runner: "claude",
  output: `{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}`,
});
assert.equal(billing?.kind, "billing",
  "credit_balance_too_low is BILLING, not auth");
assert.equal(/signing in again will not help/i.test(billing?.remedy || ""), true,
  "…and it says so, because re-auth is the trap users fall into here");

assert.equal(diagnoseRunnerFailure({ runner: "claude", output: "credit_balance_too_low" })?.kind, "billing",
  "the bare provider code classifies too");

const rateLimited = diagnoseRunnerFailure({
  runner: "claude",
  output: `{"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}}`,
});
assert.equal(rateLimited?.kind, "rate-limit",
  "rate_limit_error is throttling, not auth");
assert.equal(/do not sign in again/i.test(rateLimited?.remedy || ""), true,
  "…a fresh token does not reset a quota, and re-auth destroys a working session");

assert.equal(diagnoseRunnerFailure({ runner: "claude", output: "API Error: Rate limit reached" })?.kind, "rate-limit",
  "the CLI's own wording classifies as well as the API's");

const providerKey = diagnoseRunnerFailure({
  runner: "opencode",
  output: `AI_LoadAPIKeyError: Anthropic API key is missing. Pass it using the 'apiKey' parameter`,
});
assert.equal(providerKey?.kind, "provider-key",
  "a missing provider key is its own fault, not runner auth");
assert.equal(/separate from yaver sign-in/i.test(providerKey?.remedy || ""), true,
  "…and the remedy says which credential it means");

assert.equal(diagnoseRunnerFailure({
  runner: "opencode",
  output: `opencode service=llm providerID=openrouter AI_APICallError: User not found`,
})?.kind, "provider-key",
  "OpenRouter 'User not found' is a key problem, not a sign-out");

// OpenCode's model reference format is a documented, deterministic fix.
const modelRef = diagnoseRunnerFailure({ runner: "opencode", output: "ProviderModelNotFoundError" });
assert.equal(modelRef?.kind, "model-not-found",
  "ProviderModelNotFoundError still classifies");
assert.equal(/<providerId>\/<modelId>/.test(modelRef?.remedy || ""), true,
  "…and the remedy names the exact format, which is the whole fix");

// The entitlement 400 must lead with the CHEAP fix, not with sign-in.
const entitlement = diagnoseRunnerFailure({
  runner: "codex",
  output: `ERROR: {"status":400,"error":{"message":"The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account."}}`,
});
assert.equal(entitlement?.kind, "model-not-supported",
  "the entitlement 400 still classifies");
assert.equal(/^Pick a different model/.test(entitlement?.remedy || ""), true,
  "the remedy LEADS with picking a model — re-auth cannot move a model onto a plan");

// ── NO FALSE REDS: real auth failures must still reach the sign-in flow ────
assert.equal(diagnoseRunnerFailure({ runner: "claude", output: `{"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."}}` })?.kind,
  "auth", "an expired OAuth token IS auth and must still route to sign-in");
assert.equal(diagnoseRunnerFailure({ runner: "claude", output: "OAuth access token has been revoked" })?.kind,
  "auth-revoked", "a revoked grant is still its own terminal auth kind");

// Ordering guard: a message carrying BOTH a rate-limit and the word
// "unauthorized" must not silently fall through to the generic auth branch.
assert.equal(diagnoseRunnerFailure({ runner: "claude", output: "429 rate limit reached (unauthorized retry)" })?.kind,
  "rate-limit", "the more specific cause wins over the generic auth matcher");
