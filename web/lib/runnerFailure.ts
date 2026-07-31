export type RunnerFailureKind =
  | "model-not-found"
  | "model-not-supported"
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
      remedy: "Pick a model listed for this runner on this machine, save it as the machine default, then run Test again before retrying the chat.",
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
      remedy: "Switch to a model your subscription supports, or sign in with the account that owns that model entitlement.",
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
    lower.includes("expired token")
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
