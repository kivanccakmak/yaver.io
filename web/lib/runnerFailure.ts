export type RunnerFailureKind =
  | "model-not-found"
  | "model-not-supported"
  | "billing"
  | "rate-limit"
  | "provider-key"
  | "auth-revoked"
  | "auth"
  | "provider-transport"
  | "subprocess"
  | "unknown";

export interface RunnerFailureDiagnosis {
  kind: RunnerFailureKind;
  code?: string;
  title: string;
  reason: string;
  remedy: string;
  runner?: string;
  model?: string;
  probe?: string;
  failedAt?: number;
  fix?: {
    type: string;
    runnerId?: string;
    testAfter?: boolean;
  };
}

export interface TaskFailureWire {
  kind?: string;
  code?: string;
  title?: string;
  reason?: string;
  remedy?: string;
  runnerId?: string;
  model?: string;
  probe?: string;
  detectedAt?: number | string | Date;
  fix?: {
    type?: string;
    runnerId?: string;
    testAfter?: boolean;
  };
}

export function runnerFailureFromTaskFailure(failure?: TaskFailureWire | null): RunnerFailureDiagnosis | null {
  if (!failure || typeof failure !== "object") return null;
  const kind = runnerFailureKindFromWire(failure.kind, failure.code);
  if (!kind) return null;
  const title = String(failure.title || "").trim();
  const reason = String(failure.reason || "").trim();
  const remedy = String(failure.remedy || "").trim();
  if (!title || !reason || !remedy) return null;
  return {
    kind,
    code: String(failure.code || "").trim() || undefined,
    title,
    reason,
    remedy,
    runner: String(failure.runnerId || failure.fix?.runnerId || "").trim() || undefined,
    model: String(failure.model || "").trim() || undefined,
    probe: String(failure.probe || "").trim() || undefined,
    failedAt: normalizeTime(failure.detectedAt),
    fix: failure.fix?.type ? {
      type: String(failure.fix.type),
      runnerId: String(failure.fix.runnerId || "").trim() || undefined,
      testAfter: !!failure.fix.testAfter,
    } : undefined,
  };
}

export function diagnoseRunnerFailure(args: {
  runner?: string | null;
  model?: string | null;
  probe?: string | null;
  output?: string | null;
  error?: string | null;
  failedAt?: number | string | Date | null;
}): RunnerFailureDiagnosis | null {
  const output = String(args.output || "").trim();
  const error = String(args.error || "").trim();
  const text = `${output}\n${error}`.trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const runner = String(args.runner || "").trim() || undefined;
  const model = String(args.model || "").trim() || extractModel(text) || undefined;
  const failedAt = normalizeTime(args.failedAt);

  if (lower.includes("providermodelnotfounderror") || lower.includes("provider model not found")) {
    return {
      kind: "model-not-found",
      title: "Model is not available to this runner",
      reason: model
        ? `${runnerLabel(runner)} is signed in, but the subprocess could not open model ${model}.`
        : `${runnerLabel(runner)} is signed in, but the subprocess could not open the selected model.`,
      remedy: "Pick a model listed for this runner on this machine, save it as the machine default, then run Test again. OpenCode models must be written `<providerId>/<modelId>` (e.g. `zai-coding-plan/glm-4.7`) — a bare model id never resolves.",
      runner,
      model,
      probe: args.probe || undefined,
      failedAt,
    };
  }

  if (
    lower.includes("model is not supported") ||
    lower.includes("unsupported model") ||
    lower.includes("invalid model") ||
    lower.includes("does not have access to model")
  ) {
    return {
      kind: "model-not-supported",
      title: "Selected model is rejected by the account",
      reason: model
        ? `${runnerLabel(runner)} reached the provider, but the account cannot use ${model}.`
        : `${runnerLabel(runner)} reached the provider, but the account cannot use the selected model.`,
      // The cheap fix first. Re-authenticating cannot move a model onto a
      // plan, so leading with "sign in" sent users into a flow that could
      // never work (2026-08-02: a gpt-5.4 400 rendered the runner as
      // "sign-in needed" over a perfectly good credential).
      remedy: "Pick a different model for this machine — this one is not on the signed-in plan. Signing in again will not change that; only a different model or a different account will.",
      runner,
      model,
      probe: args.probe || undefined,
      failedAt,
    };
  }

  // ── BILLING is not AUTH ──────────────────────────────────────────────────
  // Anthropic returns 400 invalid_request_error "Your credit balance is too
  // low to access the Anthropic API." The credential is valid; the account
  // simply cannot pay for the call. Routing this to a sign-in flow is a dead
  // end — the user re-auths, retries, and hits the identical wall.
  if (
    lower.includes("credit balance is too low") ||
    lower.includes("credit_balance_too_low") ||
    lower.includes("plans & billing") ||
    (lower.includes("insufficient") && lower.includes("credit"))
  ) {
    return {
      kind: "billing",
      title: "The account is out of credit",
      reason: `${runnerLabel(runner)} authenticated fine, but the provider refused the call for lack of credit.`,
      remedy: "Top up or upgrade the plan for that provider account, then retry. Signing in again will not help — the credential is already valid.",
      runner,
      model,
      probe: args.probe || undefined,
      failedAt,
    };
  }

  // ── RATE LIMIT is not AUTH, and is not permanent ─────────────────────────
  // 429 rate_limit_error, or the CLI's own "API Error: Rate limit reached".
  // The single most important property is that WAITING fixes it: telling the
  // user to sign in both fails and destroys a working session.
  if (
    lower.includes("rate_limit_error") ||
    lower.includes("rate limit reached") ||
    lower.includes("rate limit exceeded") ||
    lower.includes("too many requests") ||
    lower.includes("429")
  ) {
    return {
      kind: "rate-limit",
      title: "Provider rate limit reached",
      reason: `${runnerLabel(runner)} was throttled by the provider — the credential and the model are both fine.`,
      remedy: "Wait for the limit to reset and retry. Do NOT sign in again; a fresh token does not reset a quota.",
      runner,
      model,
      probe: args.probe || undefined,
      failedAt,
    };
  }

  // ── A MISSING PROVIDER KEY is its own fault ──────────────────────────────
  // OpenCode loads credentials from env vars, opencode.json options.apiKey, or
  // its auth store. AI_LoadAPIKeyError / "User not found" from a provider mean
  // the KEY is missing or wrong — not that the Yaver runner is signed out, and
  // not something the runner OAuth flow touches at all.
  if (
    lower.includes("ai_loadapikeyerror") ||
    lower.includes("load api key") ||
    lower.includes("api key is missing") ||
    (lower.includes("user not found") && (lower.includes("opencode") || lower.includes("providerid") || lower.includes("openrouter")))
  ) {
    return {
      kind: "provider-key",
      title: "The provider key is missing or rejected",
      reason: `${runnerLabel(runner)} started, but the provider credential for the selected model was not accepted.`,
      remedy: "Set that provider's API key on this machine (env var, opencode.json `options.apiKey`, or `/connect`), then retry. This is separate from Yaver sign-in and from the runner's own OAuth.",
      runner,
      model,
      probe: args.probe || undefined,
      failedAt,
    };
  }

  if (lower.includes("token has been revoked") || lower.includes("oauth access token has been revoked")) {
    return {
      kind: "auth-revoked",
      title: "Runner OAuth grant was revoked",
      reason: `${runnerLabel(runner)} reached the provider, but this machine's saved OAuth grant has been revoked.`,
      remedy: "Start the runner sign-in flow from this card to issue a fresh credential, then run Test before retrying the chat.",
      runner,
      model,
      probe: args.probe || undefined,
      failedAt,
    };
  }

  if (
    lower.includes("not authenticated") ||
    lower.includes("not logged in") ||
    lower.includes("please sign in") ||
    lower.includes("invalid bearer token") ||
    lower.includes("unauthorized") ||
    lower.includes("expired token") ||
    // The strings the providers ACTUALLY emit (researched 2026-08-02). The
    // matcher above only had "expired token", so Anthropic's real message —
    // "OAuth token has expired. Please obtain a new token or refresh your
    // existing token." — fell through to `unknown` and the user got no route
    // at all for the single most common runner failure there is.
    lower.includes("token has expired") ||
    lower.includes("authentication_error") ||
    lower.includes("authentication_failed") ||
    lower.includes("oauth session expired") ||
    lower.includes("please run /login") ||
    lower.includes("run codex login")
  ) {
    return {
      kind: "auth",
      title: "Runner sign-in is invalid",
      reason: `${runnerLabel(runner)} could not authenticate the provider request.`,
      remedy: "Start the runner sign-in flow for this machine, then run Test again.",
      runner,
      model,
      probe: args.probe || undefined,
      failedAt,
    };
  }

  if (
    lower.includes("failedtoopensocket") ||
    lower.includes("ai_apicallerror") ||
    lower.includes("stream error") ||
    lower.includes("providerid=")
  ) {
    return {
      kind: "provider-transport",
      title: "Provider connection failed",
      reason: `${runnerLabel(runner)} started, but its provider request failed before a usable reply arrived.`,
      remedy: "Check the provider base URL/API key for this runner on the remote machine, then run Test again.",
      runner,
      model,
      probe: args.probe || undefined,
      failedAt,
    };
  }

  if (args.probe === "subprocess") {
    return {
      kind: "subprocess",
      title: "Runner subprocess failed",
      reason: `${runnerLabel(runner)} is installed, but a real generation subprocess exited with an error.`,
      remedy: "Open the details, inspect the subprocess output, then change the model or runner configuration and run Test again.",
      runner,
      model,
      probe: args.probe || undefined,
      failedAt,
    };
  }

  return null;
}

function runnerFailureKindFromWire(kind?: string, code?: string): RunnerFailureKind | null {
  const k = String(kind || "").trim().toLowerCase();
  const c = String(code || "").trim().toLowerCase();
  if (k === "runner_auth") return c.includes("oauth_revoked") ? "auth-revoked" : "auth";
  if (k === "runner_model") return c.includes("not_found") ? "model-not-found" : "model-not-supported";
  if (k === "runner_provider_transport") return "provider-transport";
  if (k === "runner_subprocess") return "subprocess";
  return null;
}

export function formatFailureTime(ms?: number): string | null {
  if (!ms) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function runnerLabel(runner?: string): string {
  const id = String(runner || "").toLowerCase();
  if (id === "claude") return "Claude Code";
  if (id === "codex") return "Codex";
  if (id === "opencode") return "OpenCode";
  return runner || "The runner";
}

function normalizeTime(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? undefined : t;
  }
  if (typeof value === "string" && value.trim()) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

function extractModel(text: string): string | undefined {
  const patterns = [
    /\bmodel(?:ID|Id|id)?[=:]\s*["']?([A-Za-z0-9_.:/-]+)["']?/,
    /\bmodel\s+["']([A-Za-z0-9_.:/-]+)["']/i,
    /The ['"]([^'"]+)['"] model/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1];
  }
  return undefined;
}
