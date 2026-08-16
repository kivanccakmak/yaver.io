/**
 * Cross-surface parity: web `runnerFailure.ts` vs mobile `ErrorMessage.tsx`.
 *
 * Mobile cannot import web/lib (separate app, separate bundler root), so its
 * classifier is an independent COPY. This repo has already paid for that shape
 * once — three relay-auth matchers drifted apart, none a superset of the
 * others — so the copy gets a guard instead of a promise.
 *
 * What must stay in step is not the wording but the SET OF CAUSES each surface
 * can name. A cause only web recognises is a mobile user staring at a raw
 * provider dump with no button.
 *
 * Run: npx tsx web/lib/mobileFailureParity.test.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = readFileSync(join(here, "runnerFailure.ts"), "utf8").toLowerCase();
const mob = readFileSync(join(here, "../../mobile/src/components/ErrorMessage.tsx"), "utf8").toLowerCase();

let failures = 0;
const ok = (c: unknown, label: string) => {
  if (c) console.log(`ok   ${label}`);
  else { console.error(`FAIL ${label}`); failures++; }
};

// The provider strings both surfaces must be able to name. Each entry is a
// shape observed in the wild or documented by the vendor.
const SHARED_SIGNALS: Array<[string, string]> = [
  ["credit balance is too low", "billing: the account cannot pay — re-auth is a dead end"],
  ["credit_balance_too_low", "billing: the provider's own code"],
  ["rate_limit_error", "throttling: waiting fixes it; re-auth destroys a working session"],
  ["rate limit reached", "throttling: the CLI's own wording"],
  ["oauth token has expired", "the REAL Anthropic expiry string — both matchers lacked it"],
  ["oauth session expired", "the non-interactive expiry wording"],
  ["authentication_error", "the provider's structured auth code"],
  ["authentication_failed", "the SDK's auth code"],
  ["model is not supported", "entitlement: a different model fixes it, a sign-in never does"],
];

for (const [needle, why] of SHARED_SIGNALS) {
  ok(web.includes(needle), `web names "${needle}" — ${why}`);
  ok(mob.includes(needle), `mobile names "${needle}" — ${why}`);
}

// NO FALSE REDS, on both surfaces: an entitlement / billing / throttling
// refusal must never be routed into a sign-in flow. Mobile expresses that by
// checking non-auth causes BEFORE the runner-auth branch.
const nonAuthIdx = mob.indexOf("detectnonauthproviderfailure(raw)");
const runnerAuthIdx = mob.indexOf("detectrunnerauthfailure(raw)");
ok(nonAuthIdx > 0 && runnerAuthIdx > 0 && nonAuthIdx < runnerAuthIdx,
  "mobile checks non-auth provider failures BEFORE runner-auth, so billing never renders a Sign-in button");

// Each non-auth cause must carry its OWN action; collapsing them is how an
// out-of-credit account got told to sign in.
for (const action of ["change model", "open billing", "wait and retry"]) {
  ok(mob.includes(action), `mobile offers a distinct action: "${action}"`);
}

// And the sign-in route must survive for causes that genuinely need it.
ok(mob.includes("runner-auth-needed"), "mobile still routes a REAL auth failure to sign-in");
ok(web.includes('kind: "auth-revoked"'), "web still keeps the terminal revoked kind");

if (failures) { console.error(`\nmobileFailureParity: ${failures} FAILED — a cause one surface can name and the other cannot`); process.exitCode = 1; }
else console.log("\nmobileFailureParity: ALL PASS");
