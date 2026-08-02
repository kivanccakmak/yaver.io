/**
 * Guards for runnerModelCompat — the picker must never lead with a model the
 * runner's login cannot use.
 *
 * Every NEGATIVE CONTROL below reproduces the 2026-08-02 cascade: a Vibing task
 * dispatched `gpt-5.4` at a ChatGPT-account Codex login, got a deterministic
 * 400, and spent an LLM run discovering it. If you delete the fix, the controls
 * fail — that is the point. A guard nobody has watched fail is a guess.
 *
 * Run: npx tsx web/lib/runnerModelCompat.test.ts
 */
import {
  ModelCompatLedger,
  classifyModelIncompatibility,
  codexSubscriptionSafeDefault,
  declaredSafeDefault,
  explainModelIncompatibility,
  modelCompatVerdict,
  normalizeRunner,
  orderModelsForAuthKind,
} from "./runnerModelCompat";

function eq(got: unknown, want: unknown, label: string) {
  if (got !== want) {
    console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    process.exitCode = 1;
  } else {
    console.log(`ok   ${label}`);
  }
}
function ok(cond: unknown, label: string) {
  eq(Boolean(cond), true, label);
}

// The verbatim string from the user's failed run (2026-08-02).
const LIVE_400 =
  `ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error",` +
  `"message":"The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account."}}`;

// ── learning from the operation ────────────────────────────────────────────
const learned = classifyModelIncompatibility(LIVE_400, { runner: "codex" });
ok(learned, "the live 400 is recognised at all");
eq(learned?.model, "gpt-5.4", "the refused model is extracted verbatim");
eq(learned?.runner, "codex", "the runner is attributed");
eq(learned?.authKind, "subscription", "a ChatGPT-account login is a subscription login");

// The remedy must not tell a subscription-only product to go buy API access.
ok(!/api key|buy|billing plan|upgrade/i.test(learned!.reason.replace(/API billing/i, "")),
  "the reason does not push the user toward an API key");

// ── deliberately narrow: do not blacklist on vague evidence ────────────────
eq(classifyModelIncompatibility("some unrelated crash", { runner: "codex" }), null,
  "unrelated output teaches nothing");
eq(classifyModelIncompatibility("", { runner: "codex" }), null, "empty output teaches nothing");
eq(classifyModelIncompatibility("HTTP 401 token_expired", { runner: "codex" }), null,
  "an AUTH failure is not a MODEL failure — recording it would blacklist a working model");

// ── the ledger ─────────────────────────────────────────────────────────────
const ledger = new ModelCompatLedger();
eq(ledger.has("codex", "subscription", "gpt-5.4"), false, "ledger starts empty");
eq(ledger.learnFromOutput(LIVE_400), null,
  "without a runner hint the ledger learns NOTHING — it will not guess who refused");
ledger.learnFromOutput(LIVE_400, { runner: "codex" });
eq(ledger.has("codex", "subscription", "gpt-5.4"), true, "ledger records what it observed");
eq(ledger.has("codex", "subscription", "gpt-5.3-codex"), false,
  "learning about one model says nothing about another");
ledger.learnFromOutput(LIVE_400, { runner: "codex" });
eq(ledger.toJSON().length, 1, "recording the same refusal twice is idempotent");

// Case/whitespace must not create a second entry for one model.
ledger.record("Codex", "subscription", "  GPT-5.4 ");
eq(ledger.toJSON().length, 1, "keys are normalised — no duplicate entry for the same pair");

// Round-trips, so a surface can persist and rehydrate it.
const rehydrated = ModelCompatLedger.fromJSON(ledger.toJSON());
eq(rehydrated.has("codex", "subscription", "gpt-5.4"), true, "ledger survives a JSON round-trip");
eq(ModelCompatLedger.fromJSON(["codex:subscription:gpt-5.4"])
  .has("codex", "subscription", "gpt-5.4"), true,
  "a ledger persisted by an older build (string keys) still rehydrates");

// ── NO FALSE REDS ──────────────────────────────────────────────────────────
// A blacklist that never forgets becomes a lie the day the provider adds the
// entitlement. Refusals must expire back to `unknown`.
const T0 = 1_000_000_000_000;
const aging = new ModelCompatLedger();
aging.record("codex", "subscription", "gpt-5.4", T0);
const TTL = ModelCompatLedger.DEFAULT_TTL_MS;
eq(aging.has("codex", "subscription", "gpt-5.4", T0 + TTL - 1), true,
  "a fresh refusal is still trusted just before the TTL");
eq(aging.has("codex", "subscription", "gpt-5.4", T0 + TTL), false,
  "NO FALSE RED: an aged refusal expires back to unknown, so a newly-enabled model reappears");
eq(modelCompatVerdict("codex", "gpt-5.4", "subscription", aging, T0 + TTL), "unknown",
  "after expiry the verdict is `unknown`, never `incompatible`");
ok(orderModelsForAuthKind("codex", [{ id: "gpt-5.4" }], "subscription", aging, T0 + TTL)
  .some((m) => m.id === "gpt-5.4"),
  "NO FALSE RED: an expired model is offered to the user again");

// The user can also settle it directly.
aging.record("codex", "subscription", "gpt-5.4", T0);
aging.forget("codex", "subscription", "gpt-5.4");
eq(aging.has("codex", "subscription", "gpt-5.4", T0), false,
  "a fact can be forgotten when the user proves the model works");

// prune() must drop only what is genuinely stale.
const mixed = new ModelCompatLedger();
mixed.record("codex", "subscription", "old-model", T0);
mixed.record("codex", "subscription", "new-model", T0 + TTL);
mixed.prune(TTL, T0 + TTL);
eq(mixed.has("codex", "subscription", "new-model", T0 + TTL), true, "prune keeps fresh facts");
eq(mixed.has("codex", "subscription", "old-model", T0 + TTL), false, "prune drops stale facts");

// Unknown models must remain SELECTABLE — hiding the unverified is a false red
// and would leave a fresh install with a one-item picker.
const freshInstall = new ModelCompatLedger();
const offered = orderModelsForAuthKind(
  "codex",
  [{ id: "gpt-5-codex" }, { id: "gpt-5-thinking" }, { id: "gpt-5.3-codex" }],
  "subscription",
  freshInstall,
);
eq(offered.length, 3, "NO FALSE RED: with no evidence, every model stays on offer");
eq(offered[0].id, "gpt-5.3-codex", "…the declared-safe one merely leads");

// ── verdicts ───────────────────────────────────────────────────────────────
eq(modelCompatVerdict("codex", "gpt-5.4", "subscription", ledger), "incompatible",
  "an observed refusal is incompatible");
eq(modelCompatVerdict("codex", "gpt-5.3-codex", "subscription", ledger), "declared-default",
  "the model BOTH declared defaults agree on is marked as such");
eq(modelCompatVerdict("codex", "gpt-5-codex", "subscription", ledger), "unknown",
  "no evidence means unknown — never a claim of support");

// An API-billed login is a different world: the same model is not blacklisted.
eq(modelCompatVerdict("codex", "gpt-5.4", "api-key", ledger), "unknown",
  "a subscription refusal does not condemn the model on an API-key login");

// ── the route to fix ───────────────────────────────────────────────────────
const fix = explainModelIncompatibility("codex", "gpt-5.4", "subscription", ledger);
ok(fix, "an incompatible pair explains itself");
eq(fix?.suggestedModel, codexSubscriptionSafeDefault(), "it names the model that does work");
ok(/switch the model/i.test(fix!.action), "the action is an instruction, not a description");
ok(!/api key|purchase|pay|billing/i.test(fix!.action),
  "the action never routes a subscription-only product to API billing");

eq(explainModelIncompatibility("codex", "gpt-5.3-codex", "subscription", ledger), null,
  "a model with no problem gets NO advisory — never render an advisory over silence");

// ── picker ordering: THE ACTUAL BUG ────────────────────────────────────────
// This is DevicesView MODEL_OPTIONS_BY_RUNNER.codex as it shipped: gpt-5.4
// first, so the picker's default overrode the agent's and dispatched a
// guaranteed-400 model.
const SHIPPED_CODEX_LIST = [
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5-codex", label: "GPT-5 Codex" },
  { id: "gpt-5-thinking", label: "GPT-5 Thinking" },
  { id: "gpt-5", label: "GPT-5" },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
];

const ordered = orderModelsForAuthKind("codex", SHIPPED_CODEX_LIST, "subscription", ledger);
eq(ordered[0]?.id, "gpt-5.3-codex", "the declared-safe model leads the picker");
ok(!ordered.some((m) => m.id === "gpt-5.4"), "an observed-incompatible model is not offered at all");

// NEGATIVE CONTROL: the pre-fix behaviour. If ordering is ever reverted to a
// passthrough, the first option becomes gpt-5.4 again and this fails.
eq(SHIPPED_CODEX_LIST[0].id, "gpt-5.4",
  "control: the shipped list really did lead with the model that 400s");
ok(ordered[0]?.id !== SHIPPED_CODEX_LIST[0].id,
  "control: ordering actually CHANGED the leading option (a passthrough would not)");

// Relative order of the survivors is preserved — a picker must not reshuffle.
const survivors = ordered.filter((m) => m.id !== "gpt-5.3-codex").map((m) => m.id);
eq(survivors.join(","), "gpt-5-codex,gpt-5-thinking,gpt-5",
  "non-leading options keep their original relative order (stable render)");

// Ordering is idempotent — running it twice must not move anything.
const twice = orderModelsForAuthKind("codex", ordered, "subscription", ledger);
eq(twice.map((m) => m.id).join(","), ordered.map((m) => m.id).join(","),
  "ordering is idempotent");

// An API-key login keeps the full list: gpt-5.4 via a billed OpenAI key is
// legitimate (that is what OPENCODE_PROVIDER_CATALOGUE.openai is for).
const apiOrdered = orderModelsForAuthKind("codex", SHIPPED_CODEX_LIST, "api-key", ledger);
eq(apiOrdered.length, SHIPPED_CODEX_LIST.length,
  "an API-key login is not stripped of models a subscription cannot use");

// ── misc invariants ────────────────────────────────────────────────────────
eq(normalizeRunner("claude-code"), "claude", "claude-code normalises to claude");
eq(normalizeRunner("  CODEX "), "codex", "runner ids normalise case + whitespace");
eq(declaredSafeDefault("claude"), null,
  "we state no opinion where we have no evidence — silence beats a guess");
eq(declaredSafeDefault("codex"), "gpt-5.3-codex",
  "codex default matches DEFAULT_MODEL_BY_RUNNER and the agent's fallbackRunnerModels");

// Empty/garbage input must never crash a picker.
eq(orderModelsForAuthKind("codex", [], "subscription", ledger).length, 0, "empty list is safe");
eq(modelCompatVerdict("", "", "subscription", ledger), "unknown", "blank input is unknown, not a throw");

// ── SOURCE PARITY: the shipped pickers must agree with the safe default ────
// The unit tests above prove the LOGIC. They cannot stop someone re-ordering
// the hardcoded catalogues, which is exactly how the 2026-08-02 bug shipped:
// the logic was right in two constants and wrong in the two lists the user
// actually sees. So read the real sources and assert the leading codex entry.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SAFE = codexSubscriptionSafeDefault();

/** First `{ id: "…" }` inside the `codex: [ … ]` block of a source file. */
function firstCodexModelId(source: string, label: string): string | null {
  const block = source.match(/\n\s*codex:\s*\[([\s\S]*?)\n\s*\],/);
  if (!block) {
    console.error(`FAIL ${label}: could not find a \`codex: [ … ]\` block — did the shape change?`);
    process.exitCode = 1;
    return null;
  }
  const first = block[1].match(/id:\s*["']([^"']+)["']/);
  return first ? first[1] : null;
}

const devicesView = readFileSync(join(here, "../components/dashboard/DevicesView.tsx"), "utf8");
eq(firstCodexModelId(devicesView, "DevicesView"), SAFE,
  `DevicesView MODEL_OPTIONS_BY_RUNNER.codex must LEAD with ${SAFE} (first entry is the applied default)`);

const runtimeLab = readFileSync(join(here, "../components/dashboard/RuntimeLabView.tsx"), "utf8");
eq(firstCodexModelId(runtimeLab, "RuntimeLabView"), SAFE,
  `RuntimeLabView FALLBACK_MODELS.codex must LEAD with ${SAFE}`);

// `isDefault: true` must sit on the safe model, not on whatever is first.
const codexBlock = runtimeLab.match(/\n\s*codex:\s*\[([\s\S]*?)\n\s*\],/)?.[1] || "";
const defaultLine = codexBlock.split("\n").find((l) => l.includes("isDefault: true")) || "";
ok(defaultLine.includes(SAFE),
  `RuntimeLabView's codex isDefault must be ${SAFE} — it was gpt-5.4, which cannot run on a ChatGPT-account login`);

// The provenance lie: hardcoded constants must not claim to be device inventory.
ok(!codexBlock.includes('source: "device-inventory"'),
  'FALLBACK_MODELS must not label hardcoded web constants as "device-inventory" — that is a false provenance claim');

// And the web default constant must still agree with everything above.
ok(/codex:\s*["']gpt-5\.3-codex["']/.test(devicesView),
  "DEFAULT_MODEL_BY_RUNNER.codex must stay gpt-5.3-codex");

if (process.exitCode) console.error("\nrunnerModelCompat: FAILED");
else console.log("\nrunnerModelCompat: ALL PASS");
