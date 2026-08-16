/**
 * Guards for runnerChipState — a green tick requires proof, and nothing else.
 *
 * The headline case is reproduced verbatim from the user's screen on
 * 2026-08-02, where "✓ SIGNED IN" and "Codex's token has expired" were visible
 * in the same viewport.
 *
 * Run: npx tsx web/lib/runnerChipState.test.ts
 */
import { looksLikeAuthDeath, runnerChipState, VERIFIED_PROOF_TTL_MS } from "./runnerChipState";

function eq(got: unknown, want: unknown, label: string) {
  if (got !== want) {
    console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    process.exitCode = 1;
  } else {
    console.log(`ok   ${label}`);
  }
}
const ok = (c: unknown, label: string) => eq(Boolean(c), true, label);

const CODEX = { runnerLabel: "Codex", installed: true };

// ── THE LIVE FALSE GREEN ───────────────────────────────────────────────────
// What the agent actually reported: a credential file that `codex login status`
// vouched for, while the provider had already stopped accepting the token.
const live = runnerChipState({
  ...CODEX,
  authConfigured: true,
  authPresent: true,
  authVerified: false,
  lastError: "Could not start OpenAI Codex: runner not ready: Codex's token has expired and could not be refreshed. Sign in again.",
});
eq(live.tone, "expired", "an observed token_expired outranks every local vouch");
eq(live.showsGreenTick, false, "THE BUG: this rendered a green ✓ SIGNED IN next to its own contradiction");
ok(/sign codex in again/i.test(live.action || ""), "it names the next tap");

// The same row WITHOUT the failure is the state the screenshot should have had:
// evidence, but not proof — so no tick, and no nagging either.
const vouched = runnerChipState({ ...CODEX, authConfigured: true, authPresent: true, authVerified: false });
eq(vouched.tone, "present", "a local vouch is `present`, not `verified`");
eq(vouched.showsGreenTick, false, "NO FALSE GREEN: a local vouch never earns the tick");
eq(vouched.action, null, "NO FALSE RED: a probably-fine runner is not given a chore");
ok(/unverified/i.test(vouched.label), "the label says exactly what is known");

// ── proof, and only proof, earns the tick ─────────────────────────────────
const NOW = 1_800_000_000_000;
const proven = runnerChipState({ ...CODEX, authConfigured: true, authVerified: true, authVerifiedAt: NOW - 60_000 }, NOW);
eq(proven.tone, "verified", "an exercised credential is verified");
eq(proven.showsGreenTick, true, "…and that is the ONLY thing that earns a green tick");
eq(proven.detail, null, "a healthy runner says nothing — quiet beats busy");

// Ancient proof is no longer proof, but it is not a failure either.
const stale = runnerChipState(
  { ...CODEX, authConfigured: true, authVerified: true, authVerifiedAt: NOW - VERIFIED_PROOF_TTL_MS - 1 },
  NOW,
);
eq(stale.tone, "present", "proof older than the TTL demotes to `present`");
eq(stale.showsGreenTick, false, "…so an ancient success cannot underwrite a tick forever");
eq(stale.action, null, "NO FALSE RED: demotion is not an alarm");

// Just inside the TTL still counts — the chip must not flap on an idle box.
eq(
  runnerChipState({ ...CODEX, authConfigured: true, authVerified: true, authVerifiedAt: NOW - VERIFIED_PROOF_TTL_MS + 1 }, NOW).tone,
  "verified",
  "recent proof is still proof",
);

// ── the agent's direct statements ─────────────────────────────────────────
eq(runnerChipState({ ...CODEX, authConfigured: false }).tone, "missing",
  "authConfigured:false is a direct statement of fact and is honoured");
eq(runnerChipState({ ...CODEX, needsAuth: true, authConfigured: true }).tone, "missing",
  "needsAuth:true wins over a stale authConfigured");
eq(runnerChipState({ runnerLabel: "Codex", installed: false }).tone, "missing",
  "an uninstalled runner is not a sign-in problem, and says so");
ok(/not installed/i.test(runnerChipState({ runnerLabel: "Codex", installed: false }).detail || ""),
  "…it names the real cause rather than blaming auth");

// An older agent that reports none of these must not be guessed about.
eq(runnerChipState({ runnerLabel: "Codex", installed: true }).tone, "unknown",
  "no fields reported = unknown, never an invented green or red");
eq(runnerChipState({ runnerLabel: "Codex", installed: true }).showsGreenTick, false,
  "unknown never shows a tick");

// ── NO FALSE REDS: the death matcher stays narrow ─────────────────────────
ok(looksLikeAuthDeath("token_expired"), "token_expired is auth death");
ok(looksLikeAuthDeath("Codex's token has expired and could not be refreshed."), "the agent's own sentence matches");
ok(looksLikeAuthDeath("refresh_token_reused"), "a reused refresh token is auth death");
ok(looksLikeAuthDeath("HTTP 401 Unauthorized"), "a 401 is auth death");

eq(looksLikeAuthDeath("Metro bundler failed: SyntaxError in app/index.tsx"), false,
  "NO FALSE RED: a compile error is not an expired login");
eq(looksLikeAuthDeath("ECONNRESET"), false, "NO FALSE RED: a transport blip is not an expired login");
eq(looksLikeAuthDeath("The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account."), false,
  "NO FALSE RED: a model-entitlement 400 is NOT a dead credential — sending the user to re-auth would not fix it");
eq(looksLikeAuthDeath(""), false, "empty text proves nothing");
eq(looksLikeAuthDeath(null), false, "null text proves nothing");

// A build failure on a runner whose credential is fine must stay green.
const buildFailed = runnerChipState({
  ...CODEX,
  authConfigured: true,
  authVerified: true,
  authVerifiedAt: NOW - 1000,
  lastError: "Metro bundler failed: SyntaxError in app/(tabs)/index.tsx line 42",
}, NOW);
eq(buildFailed.tone, "verified",
  "NO FALSE RED: a code error must not demote a proven sign-in — that would send the user to a pointless OAuth flow");
eq(buildFailed.showsGreenTick, true, "…and the tick stays");

if (process.exitCode) console.error("\nrunnerChipState: FAILED");
else console.log("\nrunnerChipState: ALL PASS");
