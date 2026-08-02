/**
 * runnerModelCompat — which models a SUBSCRIPTION-backed runner login can
 * actually run, and how we learn the answer instead of guessing it.
 *
 * ── THE INCIDENT (2026-08-02) ───────────────────────────────────────────────
 *
 * Vibing dispatched a task with `MODEL / gpt-5.4` against a Codex runner signed
 * in with a ChatGPT account. It could never have worked:
 *
 *     ERROR: {"status":400,"error":{"type":"invalid_request_error","message":
 *       "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT
 *        account."}}
 *
 * The product already KNEW this. The string is classified and tested in five
 * places (desktop/agent/runner_auth_invalid_test.go, runner_failure_
 * classification_test.go, web/lib/runnerFailure.test.ts, mobile
 * DeviceContext.tsx, TaskTargetWizard.tsx), and BOTH declared defaults are
 * correct — `DEFAULT_MODEL_BY_RUNNER.codex` and the agent's own
 * `fallbackRunnerModels` both say `gpt-5.3-codex`, each with a comment
 * explaining that general `gpt-5.x` need API billing.
 *
 * The knowledge simply never reached the list the user picks FROM:
 *   • web/components/dashboard/DevicesView.tsx  MODEL_OPTIONS_BY_RUNNER.codex
 *       → led with `gpt-5.4`, hint "stable default fallback"
 *   • web/components/dashboard/RuntimeLabView.tsx  FALLBACK_MODELS.codex
 *       → `gpt-5.4` with `isDefault: true`
 *
 * So the picker overrode the agent, and the user paid an LLM run to discover a
 * 400 that two constants in this repo already predicted.
 *
 * ── WHY THIS FILE DOES NOT SHIP A HARDCODED "SUPPORTED MODELS" LIST ─────────
 *
 * Because we do not actually know it, and a confident wrong list is worse than
 * no list. Evidence that the obvious table would be wrong: the agent's own
 * `fallbackRunnerModels("codex")` (httpserver.go:3902) warns that general
 * gpt-5.x require API billing and then OFFERS `gpt-5.5`, `gpt-5.5-pro`,
 * `gpt-5.4`, `gpt-5.4-mini` anyway — it contradicts itself in eight lines. And
 * the observed failures name different models over time (`gpt-5.4` here,
 * `gpt-5.5-pro` in TaskTargetWizard's comment), because OpenAI moves the set.
 *
 * A list I invent today is a false green tomorrow. So instead:
 *
 *   1. LEAD with the model the product's own two defaults already agree on.
 *      That is not a guess — it is making the picker stop DISAGREEING with the
 *      agent. `codexSubscriptionSafeDefault()`.
 *   2. LEARN the rest from the operation. `classifyModelIncompatibility()`
 *      parses the exact 400 the runner emits and yields a durable
 *      (runner, model) fact. Feed it back via `ModelCompatLedger` and the pair
 *      is never defaulted to again.
 *   3. Everything else is UNKNOWN, and says so, rather than claiming support.
 *
 * This is the "probe the operation, never the inventory" rule applied to a
 * catalogue: we report what we have observed, not what we assume.
 */

import { diagnoseRunnerFailure } from "./runnerFailure";

/** How a runner authenticates. Subscription = OAuth against a consumer
 *  account (ChatGPT / claude.ai). `api-key` = the user's own billed key. */
export type RunnerAuthKind = "subscription" | "api-key" | "unknown";

/** What we can say about one (runner, model) pair. */
export type ModelCompatVerdict =
  /** Observed to fail on this auth kind — never offer as a default. */
  | "incompatible"
  /** Declared safe by both the agent and the web default. */
  | "declared-default"
  /** No evidence either way. Offer it, but never lead with it. */
  | "unknown";

/**
 * The Codex model both declared defaults agree on:
 *   - web  `DEFAULT_MODEL_BY_RUNNER.codex`      (DevicesView.tsx)
 *   - agent `fallbackRunnerModels("codex")`     (httpserver.go, IsDefault:true)
 *
 * Exported as a function rather than a bare const so a future change has one
 * place to touch and every picker moves together.
 */
export function codexSubscriptionSafeDefault(): string {
  // MEASURED 2026-08-02, not inferred. `codex exec --model <id> "reply OK"` on
  // two machines signed in with the owner's ChatGPT account:
  //
  //   WORKS     gpt-5.6-terra, gpt-5.6-sol, gpt-5.6-luna, gpt-5.5,
  //             gpt-5.4, gpt-5.4-mini
  //   REJECTED  gpt-5.6, gpt-5.5-pro, gpt-5.3-codex, gpt-5-thinking,
  //             gpt-5, gpt-5-mini, o3
  //
  // This function returned `gpt-5.3-codex` for a few hours on the strength of
  // the "-codex suffix means codex-safe" instinct. It is the one id in the
  // list the subscription flatly refuses (withdrawn for ChatGPT auth
  // 2026-06-02), and pointing every picker at it broke the vibe loop on every
  // surface. OpenAI's own guidance names terra as the gpt-5.4 replacement.
  return "gpt-5.6-terra";
}

/** The declared-safe default per runner, or null when we have no opinion. */
export function declaredSafeDefault(runner: string): string | null {
  switch (normalizeRunner(runner)) {
    case "codex":
      return codexSubscriptionSafeDefault();
    default:
      return null;
  }
}

export function normalizeRunner(runner: string | null | undefined): string {
  const n = String(runner || "").trim().toLowerCase();
  return n === "claude-code" ? "claude" : n;
}

/**
 * Turn a runner's own refusal into a durable fact.
 *
 * DELEGATES to `diagnoseRunnerFailure` rather than carrying a second regex.
 * That is deliberate: mobile already ships THREE different relay-auth matchers,
 * none a superset of the others, and they drifted apart silently. A classifier
 * that lives beside another classifier for the same string is a future bug, so
 * this module owns the LEDGER and `runnerFailure.ts` owns the PARSING.
 *
 * Returns null unless the diagnosis is specifically `model-not-supported` AND
 * names a model — an account-entitlement refusal we cannot attribute to a model
 * teaches us nothing, and recording it against the wrong model would blacklist
 * something that works. That is the one failure mode worse than the bug we are
 * fixing here.
 */
export function classifyModelIncompatibility(
  output: string | null | undefined,
  opts?: { runner?: string | null; model?: string | null },
): { runner: string; model: string; authKind: RunnerAuthKind; reason: string } | null {
  const diagnosis = diagnoseRunnerFailure({
    runner: opts?.runner ?? null,
    model: opts?.model ?? null,
    output: output ?? null,
  });
  if (!diagnosis || diagnosis.kind !== "model-not-supported") return null;
  const model = String(diagnosis.model || "").trim();
  if (!model) return null;
  const runner = normalizeRunner(diagnosis.runner || opts?.runner || "");
  if (!runner) return null;
  return {
    runner,
    model,
    authKind: "subscription",
    reason: `${model} is not available on a subscription ${runner} login (it needs API billing).`,
  };
}

/**
 * A ledger of pairs we have OBSERVED to fail. Pure and injectable so callers
 * can persist it however they like (device row, localStorage, Convex) without
 * this module owning storage.
 *
 * Keys are `${runner}:${authKind}:${model}` lowercased.
 */
export class ModelCompatLedger {
  /** key → epoch-ms when the refusal was observed. */
  private failed = new Map<string, number>();

  /**
   * How long an observed refusal is trusted.
   *
   * NO FALSE REDS. A permanent blacklist is itself a lie waiting to happen:
   * providers add model entitlements all the time, and a model we watched fail
   * in August may be included in the subscription by October. If we remembered
   * forever, the product would hide a working model and the user would have no
   * way to discover it — a false RED, which costs exactly as much trust as the
   * false GREEN this module exists to kill.
   *
   * So refusals EXPIRE. After the TTL the pair returns to `unknown`: offered
   * again, still not led with. If it genuinely still fails, we observe it once
   * more and record it again — one wasted dispatch per TTL, versus a
   * permanently invisible model. That trade is the right way round.
   */
  static readonly DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

  static key(runner: string, authKind: RunnerAuthKind, model: string): string {
    return `${normalizeRunner(runner)}:${authKind}:${String(model).trim().toLowerCase()}`;
  }

  /** Record a real refusal. Idempotent; re-recording refreshes the timestamp. */
  record(runner: string, authKind: RunnerAuthKind, model: string, at: number = Date.now()): void {
    this.failed.set(ModelCompatLedger.key(runner, authKind, model), at);
  }

  /** Drop a specific fact — e.g. the user proved the model works. */
  forget(runner: string, authKind: RunnerAuthKind, model: string): void {
    this.failed.delete(ModelCompatLedger.key(runner, authKind, model));
  }

  /** Drop every fact older than the TTL. Safe to call on every read. */
  prune(ttlMs: number = ModelCompatLedger.DEFAULT_TTL_MS, now: number = Date.now()): void {
    for (const [k, at] of this.failed) {
      if (now - at >= ttlMs) this.failed.delete(k);
    }
  }

  /**
   * Learn directly from runner output; returns the fact it learned, if any.
   *
   * `opts.runner` is effectively REQUIRED: the dispatching surface always knows
   * which runner it invoked, and `diagnoseRunnerFailure` does not infer a runner
   * from prose. Called without it we return null rather than attribute the
   * refusal to a guess — blacklisting a model against the wrong runner would
   * hide a model that works, which is worse than learning nothing.
   */
  learnFromOutput(
    output: string | null | undefined,
    opts?: { runner?: string | null; model?: string | null },
  ) {
    const fact = classifyModelIncompatibility(output, opts);
    if (fact) this.record(fact.runner, fact.authKind, fact.model);
    return fact;
  }

  /** True only for a refusal observed within the TTL (see DEFAULT_TTL_MS). */
  has(
    runner: string,
    authKind: RunnerAuthKind,
    model: string,
    now: number = Date.now(),
    ttlMs: number = ModelCompatLedger.DEFAULT_TTL_MS,
  ): boolean {
    const at = this.failed.get(ModelCompatLedger.key(runner, authKind, model));
    if (at === undefined) return false;
    return now - at < ttlMs;
  }

  /** Serialisable snapshot, so a surface can persist and rehydrate it. */
  toJSON(): Array<{ key: string; at: number }> {
    return [...this.failed]
      .map(([key, at]) => ({ key, at }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  static fromJSON(
    entries: readonly { key: string; at: number }[] | readonly string[] | null | undefined,
  ): ModelCompatLedger {
    const l = new ModelCompatLedger();
    for (const e of entries || []) {
      // Tolerate the older string-only shape so a persisted ledger from a
      // previous build rehydrates instead of throwing. An entry with no
      // timestamp is treated as observed NOW rather than as ancient — the
      // conservative read, since we cannot prove it is stale.
      if (typeof e === "string") l.failed.set(e, Date.now());
      else if (e && typeof e.key === "string") l.failed.set(e.key, Number(e.at) || Date.now());
    }
    return l;
  }
}

/**
 * Facts we have OBSERVED in production, with the date we saw them.
 *
 * This is evidence, not a guess — the distinction the whole file rests on. Each
 * entry is a refusal someone actually watched a runner emit, so seeding them is
 * the same act as learning them at runtime, just earlier. It is NOT a
 * "supported models" table: nothing here claims a model WORKS.
 *
 * They carry the normal TTL, so if the provider later includes the model the
 * seed ages out and the model returns to `unknown` — offered again, merely not
 * led with. That is deliberate: a permanent seed would become a false red.
 */
const OBSERVED_REFUSALS: ReadonlyArray<{
  runner: string; authKind: RunnerAuthKind; model: string; observedAt: string; note: string;
}> = [
  // MEASURED, not transcribed from an error message. On 2026-08-02 this table
  // contained exactly one row — `gpt-5.4` — and that row is what broke the
  // product: the dispatch funnel below coerced every saved gpt-5.4 into the
  // then-"safe" gpt-5.3-codex, which the subscription actually refuses. So a
  // WORKING model was rewritten into a DEAD one on every task, on every
  // surface, and the vibe loop failed on both.
  //
  // The rows below come from running the operation on two machines signed in
  // with the owner's ChatGPT account (`codex exec --model <id> "reply OK"`):
  //
  //   WORKS     gpt-5.6-terra, gpt-5.6-sol, gpt-5.6-luna, gpt-5.5,
  //             gpt-5.4, gpt-5.4-mini
  //   REJECTED  everything listed here
  //
  // Adding a row on the strength of a single 400 is how the last one got here.
  // Probe both directions before editing: a refusal that is really a rate
  // limit, an outage, or a bad prompt costs users a working model.
  ...(["gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.6", "gpt-5.5-pro", "gpt-5-thinking", "gpt-5", "gpt-5-mini", "o3"].map(
    (model) => ({
      runner: "codex",
      authKind: "subscription" as RunnerAuthKind,
      model,
      observedAt: "2026-08-02",
      note: "codex exec --model " + model + " → \"not supported when using Codex with a ChatGPT account\"",
    }),
  )),
];

/**
 * A ledger pre-loaded with {@link OBSERVED_REFUSALS}. Callers that have no
 * persisted ledger should use this rather than an empty one, so a model we have
 * already watched fail is not re-dispatched on every fresh browser session.
 */
export function seededLedger(now: number = Date.now()): ModelCompatLedger {
  const l = new ModelCompatLedger();
  for (const f of OBSERVED_REFUSALS) {
    const at = Date.parse(`${f.observedAt}T00:00:00Z`);
    l.record(f.runner, f.authKind, f.model, Number.isFinite(at) ? at : now);
  }
  return l;
}

/**
 * Resolve the model a dispatch should ACTUALLY use.
 *
 * The picker default was only half the 2026-08-02 bug: the model is also a
 * STORED per-device setting, so a `gpt-5.4` chosen before the fix keeps being
 * sent forever — re-ordering a list does not migrate a saved value. (The same
 * lesson mobile already learned: DeviceContext.loadSettings migrates the older
 * `o3-mini` / `gpt-5-codex` intermediates away.)
 *
 * Returns the stored model untouched unless we have OBSERVED it fail on this
 * auth kind, in which case it returns the declared-safe model plus the reason,
 * so the surface can say what it changed and why instead of silently swapping
 * the user's choice.
 */
export function resolveUsableModel(
  runner: string,
  storedModel: string | null | undefined,
  authKind: RunnerAuthKind = "subscription",
  ledger: ModelCompatLedger = seededLedger(),
  now: number = Date.now(),
): { model: string | null; changed: boolean; reason?: string; action?: string } {
  const stored = String(storedModel || "").trim();
  if (!stored) return { model: declaredSafeDefault(runner), changed: false };
  const why = explainModelIncompatibility(runner, stored, authKind, ledger, now);
  if (!why || !why.suggestedModel) return { model: stored, changed: false };
  return {
    model: why.suggestedModel,
    changed: true,
    reason: `${stored} was saved for this machine, but ${why.reason.replace(/^.*? is /, "it is ")}`,
    action: why.action,
  };
}

/**
 * The verdict for one pair. `ledger` is optional — with no ledger we can still
 * distinguish "the default both sides declare" from "no evidence".
 */
export function modelCompatVerdict(
  runner: string,
  model: string,
  authKind: RunnerAuthKind = "subscription",
  ledger?: ModelCompatLedger,
  now: number = Date.now(),
): ModelCompatVerdict {
  const r = normalizeRunner(runner);
  const m = String(model || "").trim();
  if (!r || !m) return "unknown";
  if (ledger?.has(r, authKind, m, now)) return "incompatible";
  if (authKind === "subscription" && declaredSafeDefault(r) === m) return "declared-default";
  return "unknown";
}

/**
 * The route-to-fix for a pair we know cannot work. Returns null when there is
 * nothing to say — callers must not render an advisory over silence.
 *
 * Deliberately does NOT suggest buying API access: the house rule is
 * subscription-only (feedback_no_api_keys_subscription_only), so the remedy is
 * to pick the model the existing subscription already covers.
 */
export function explainModelIncompatibility(
  runner: string,
  model: string,
  authKind: RunnerAuthKind = "subscription",
  ledger?: ModelCompatLedger,
  now: number = Date.now(),
): { reason: string; action: string; suggestedModel: string | null } | null {
  if (modelCompatVerdict(runner, model, authKind, ledger, now) !== "incompatible") return null;
  const suggested = declaredSafeDefault(runner);
  const r = normalizeRunner(runner);
  return {
    reason: `${model} is not available on a subscription ${r} login.`,
    action: suggested
      ? `Switch the model to ${suggested}, which this login already covers.`
      : `Pick a model this login covers.`,
    suggestedModel: suggested,
  };
}

/**
 * Order a picker's options so a subscription login never LEADS with a model we
 * have no evidence for, and never offers one we have watched fail.
 *
 * Contract:
 *   - incompatible pairs are dropped entirely (they cannot succeed),
 *   - the declared-safe default sorts first,
 *   - everything else keeps its original relative order.
 *
 * Stable by construction so a picker does not reshuffle between renders.
 */
export function orderModelsForAuthKind<T extends { id: string }>(
  runner: string,
  models: readonly T[],
  authKind: RunnerAuthKind = "subscription",
  ledger?: ModelCompatLedger,
  now: number = Date.now(),
): T[] {
  const safe = declaredSafeDefault(runner);
  // NOTE: only OBSERVED-incompatible pairs are dropped. `unknown` models stay
  // in the list — we simply never LEAD with them. Hiding everything we have not
  // personally verified would be a false red, and would leave the picker with
  // one option on a fresh install.
  const kept = models.filter(
    (m) => modelCompatVerdict(runner, m.id, authKind, ledger, now) !== "incompatible",
  );
  if (authKind !== "subscription" || !safe) return [...kept];
  const lead = kept.filter((m) => m.id === safe);
  const rest = kept.filter((m) => m.id !== safe);
  return [...lead, ...rest];
}
