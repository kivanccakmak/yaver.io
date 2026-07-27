import { diagnoseRunnerFailure } from "./runnerFailure";

function eq(got: unknown, want: unknown, label: string) {
  if (got !== want) {
    console.error(`FAIL ${label}: got ${String(got)}, want ${String(want)}`);
    process.exitCode = 1;
  } else {
    console.log(`ok ${label}`);
  }
}

const providerNotFound = diagnoseRunnerFailure({
  runner: "claude",
  model: "claude-opus-4-7",
  probe: "subprocess",
  output: "ProviderModelNotFoundError: ProviderModelNotFoundError",
  failedAt: 1_000,
});
eq(providerNotFound?.kind, "model-not-found", "ProviderModelNotFoundError classifies as model-not-found");
eq(providerNotFound?.model, "claude-opus-4-7", "explicit model survives");
eq(providerNotFound?.failedAt, 1_000, "timestamp survives");

const codexUnsupported = diagnoseRunnerFailure({
  runner: "codex",
  output: `ERROR: {"message":"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account."}`,
});
eq(codexUnsupported?.kind, "model-not-supported", "unsupported model classifies");
eq(codexUnsupported?.model, "gpt-5.3-codex", "model extracted from provider error");

const auth = diagnoseRunnerFailure({
  runner: "claude",
  error: "invalid bearer token",
});
eq(auth?.kind, "auth", "auth failure classifies");

const subprocess = diagnoseRunnerFailure({
  runner: "claude",
  probe: "subprocess",
  error: "exit status 1",
});
eq(subprocess?.kind, "subprocess", "generic subprocess failure classifies");

eq(diagnoseRunnerFailure({ error: "" }), null, "empty failure returns null");
