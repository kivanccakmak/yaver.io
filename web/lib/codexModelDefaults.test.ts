import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Anchored on THIS file, never on process.cwd(): the guard sweep
// (scripts/run-client-guards.sh) runs from the repo root while a human runs it
// from web/, and a cwd-relative path turns that difference into a red test that
// says nothing about the code it guards.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition: unknown, message: string) {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok ${message}`);
  }
}

const devicesView = readFileSync(join(root, "components/dashboard/DevicesView.tsx"), "utf8");
const runtimeLab = readFileSync(join(root, "components/dashboard/RuntimeLabView.tsx"), "utf8");

// ── THE POLARITY OF THIS GUARD WAS INVERTED ON 2026-08-02 ──────────────────
//
// It used to assert `gpt-5.4` as the Codex default and treat `gpt-5.3-codex`
// as "stale". That was written from a model-recency instinct rather than from
// an observed operation, and it is backwards for THIS product: Yaver runs
// coding agents on SUBSCRIPTION logins only (never API keys — see CLAUDE.md),
// and a ChatGPT-account Codex login cannot run general gpt-5.x at all:
//
//   {"status":400,"error":{"type":"invalid_request_error","message":
//    "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT
//     account."}}
//
// A Vibing task paid a real LLM run to discover that 400 while BOTH declared
// defaults in this repo — DEFAULT_MODEL_BY_RUNNER.codex and the agent's own
// fallbackRunnerModels — already said gpt-5.3-codex. The picker overrode them
// because it renders closer to the user. So: the picker must AGREE with the
// defaults, and the newest-sounding id is not the runnable one.
// Model of the compatibility question: web/lib/runnerModelCompat.ts.
assert(/codex:\s*"gpt-5\.6-terra"/.test(devicesView),
  "DevicesView codex default is a model PROBED to work on a subscription login");

const modelOptionsStart = devicesView.indexOf("export const MODEL_OPTIONS_BY_RUNNER");
const modelOptionsBody = modelOptionsStart >= 0 ? devicesView.slice(modelOptionsStart) : devicesView;
const codexOptions = modelOptionsBody.slice(
  modelOptionsBody.indexOf("codex: ["),
  modelOptionsBody.indexOf("],", modelOptionsBody.indexOf("codex: [")),
);
// ORDER MATTERS — the first entry is the default this picker applies.
assert(/^\s*codex: \[\s*\{ id: "gpt-5\.6-terra"/.test(codexOptions),
  "the codex picker LEADS with the same model the declared defaults name");
// gpt-5.4 still WORKS on a subscription today, so it stays offered — but it
// retires for ChatGPT sign-in on 2026-08-31, and a user who picks it without
// being told that meets the failure alone, after the date, mid-task.
assert(!/\{ id: "gpt-5\.4"/.test(codexOptions) || /gpt-5\.4"[^}]*2026-08-31/.test(codexOptions),
  "if gpt-5.4 is offered, its hint must state the 2026-08-31 retirement");

const fallbackStart = runtimeLab.indexOf("codex: [");
const fallbackCodex = fallbackStart >= 0 ? runtimeLab.slice(fallbackStart, runtimeLab.indexOf("],", fallbackStart)) : "";
assert(/\{ id: "gpt-5\.6-terra"[^}]*isDefault: true/.test(fallbackCodex),
  "RuntimeLab's fallback catalogue defaults to the same model the picker leads with");

// NOTHING IN EITHER CODEX LIST MAY BE A MODEL THE SUBSCRIPTION REJECTS.
//
// Scoped to the CODEX blocks deliberately. An earlier draft of this guard
// scanned the whole file and flagged `gpt-5-mini` in DevicesView — which lives
// in the OpenCode BYO-key provider catalogue (`requiresKey: true`,
// keyEnv OPENAI_API_KEY). That path bills the user's own OpenAI key, where the
// model is perfectly valid; only the SUBSCRIPTION path rejects it. A guard
// that cannot tell those apart would force a real capability out of the
// product to satisfy a test.
//
// The rejected set is measured, not reasoned: `codex exec --model <id>` on two
// machines signed in with the ChatGPT account, 2026-08-02. Both polarities of
// guess have already shipped broken here, so evidence is the only admissible
// argument for editing this list.
for (const dead of ["gpt-5.3-codex", "gpt-5.2-codex", "gpt-5-thinking", "gpt-5-mini", "gpt-5.5-pro", "o3"]) {
  const pat = new RegExp(`id: "${dead.replace(/\./g, "\\.")}"`);
  assert(!pat.test(codexOptions),
    `the codex picker offers ${dead}, which a ChatGPT-account Codex login rejects outright`);
  assert(!pat.test(fallbackCodex),
    `RuntimeLab's codex fallback offers ${dead}, which a ChatGPT-account login rejects outright`);
}
assert(!/\{ id: "gpt-5\.4"[^}]*isDefault: true/.test(fallbackCodex),
  "RuntimeLab does not re-introduce gpt-5.4 as the default behind the picker's back");
// The fallback list is hardcoded web constants — it must not claim the device
// told us. A provenance label stronger than the evidence is the same class of
// bug as a green status over an unreachable box.
assert(!/source: "device-inventory"/.test(fallbackCodex),
  "the fallback catalogue is labelled 'fallback', never 'device-inventory'");

const dashboardPage = readFileSync(join(root, "app/dashboard/page.tsx"), "utf8");
assert(/probeDeviceStatus\(\{[\s\S]*deviceId: d\.id[\s\S]*usableTunnelUrls/.test(dashboardPage), "dashboard auto-connect probes the real browser transport");
assert(!/d\.online === true/.test(dashboardPage.slice(dashboardPage.indexOf("const autoConnectTriedRef"), dashboardPage.indexOf("const refreshConnectedRunners"))), "dashboard auto-connect does not treat heartbeat-only online as browser-reachable");

const vibeView = readFileSync(join(root, "components/dashboard/VibeCodingView.tsx"), "utf8");
assert(/const explicitInstalled = explicitRunner \? installed\.find/.test(vibeView), "Vibe keeps the machine primary runner selected when it is installed");
assert(/!selectedRunner \|\| !selectedStillAvailable/.test(vibeView), "Vibe only falls forward when the selected runner is absent, not merely blocked");
assert(/activeFailureSignInRunner/.test(vibeView), "Vibe failed task card exposes runner sign-in recovery for auth failures");
