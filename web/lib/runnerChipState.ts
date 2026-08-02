/**
 * runnerChipState — what the runner chip is allowed to CLAIM.
 *
 * ── The live screenshot this exists for (2026-08-02) ────────────────────────
 *
 * Side by side, in one viewport:
 *
 *     sidebar:  runner: Codex   ✓ SIGNED IN
 *     chat:     Could not start OpenAI Codex: runner not ready:
 *               Codex's token has expired and could not be refreshed.
 *
 * Both were rendered from the same device row. The chip is not merely stale —
 * it contradicts a fact already on the screen.
 *
 * ── Why it happened: a produced signal with no consumer ─────────────────────
 *
 * The agent has modelled this correctly for months. runner_auth.go:29-31 ships
 * THREE distinct fields and documents the difference in the struct itself:
 *
 *   authConfigured — a credential exists in some form
 *   authPresent    — `codex login status` vouched for it. That command "reads
 *                    ~/.codex/auth.json and checks shape/expiry LOCALLY … it
 *                    cannot see a server-side revocation. PRESENT, not VERIFIED"
 *   authVerified   — the credential was actually EXERCISED against the provider
 *                    and worked. runner_auth.go:191-198 calls this "deliberately
 *                    the ONLY positive writer: no local probe, however
 *                    authoritative-looking, is allowed to claim it"
 *
 * All three reach the browser — web/lib/use-devices.ts:128-132 types them and
 * DevicesView.tsx:531-533 parses them. And then the chip logic
 * (app/dashboard/page.tsx runnerAuthIssue) consults ONLY `authConfigured`, so a
 * locally-well-formed but server-side-dead token renders as a green tick.
 *
 * The agent drew the exact distinction that would have prevented this, shipped
 * it, and the surface threw it away. That is the "signal with no consumer"
 * defect, and it is why the fix belongs here rather than in the agent.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *
 * A GREEN TICK REQUIRES PROOF. Only `authVerified` — a credential that has been
 * exercised — earns "Signed in".
 *
 * NO FALSE REDS EITHER. `authPresent` is real evidence: the runner's own CLI
 * vouched for the credential, and most of the time it is right. Rendering that
 * as "not signed in" would nag users whose setup is fine and would train them
 * to ignore the chip. So it gets its own honest, non-alarming state —
 * "Signed in · unverified" — which claims exactly what is known and no more.
 *
 * Four states, and the boundary between the middle two is the whole point:
 *
 *   verified    proven by use              green tick, no action
 *   present     vouched locally, unproven  neutral, no action, says "unverified"
 *   expired     a real failure was seen    amber + the re-auth route
 *   missing     no credential at all       amber + the sign-in route
 */

export type RunnerChipTone = "verified" | "present" | "expired" | "missing" | "unknown";

export interface RunnerChipState {
  tone: RunnerChipTone;
  /** Short text for the chip itself. Never claims more than `tone` allows. */
  label: string;
  /** One sentence of detail, or null when there is nothing worth saying. */
  detail: string | null;
  /** The next tap, phrased as an instruction. Null when nothing is required. */
  action: string | null;
  /** True only when the chip may render a green success tick. */
  showsGreenTick: boolean;
}

export interface RunnerChipInput {
  runnerLabel: string;
  installed?: boolean;
  ready?: boolean;
  authConfigured?: boolean;
  needsAuth?: boolean;
  /** Local vouch (`codex login status`) — shape+expiry only, no server call. */
  authPresent?: boolean;
  /** Exercised against the provider and worked. The ONLY green-tick source. */
  authVerified?: boolean;
  /** Epoch ms of the last successful exercise, when known. */
  authVerifiedAt?: number;
  /** Most recent runner error/warning text, if any. */
  lastError?: string | null;
}

/**
 * How long a proof stays proof.
 *
 * A credential exercised a month ago tells you very little today — tokens
 * expire, accounts get revoked. But demoting proof too eagerly would flap the
 * chip on an idle machine, so this is generous: it exists to stop an ANCIENT
 * success underwriting a green tick forever, not to second-guess a recent one.
 */
export const VERIFIED_PROOF_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Failure text that proves the credential is dead RIGHT NOW.
 *
 * Kept narrow on purpose. These phrases are the ones the agent's own
 * classifier emits (desktop/agent/runner_auth.go:505-527) plus the raw provider
 * strings behind them. A loose match here would turn an unrelated crash into
 * "your login expired", send the user through a pointless OAuth flow, and be a
 * false red — the exact failure mode this file is also trying to avoid.
 */
const OBSERVED_AUTH_DEATH =
  /token[_ ]expired|token has expired|refresh_token_reused|codex login --device-auth|please run `?codex login`?|no longer accepted|not authenticated|sign in again|invalid[_ ]grant|401 unauthorized|unauthorized/i;

/** True when this text is proof the credential is dead, not merely a failure. */
export function looksLikeAuthDeath(text: string | null | undefined): boolean {
  const t = String(text || "").trim();
  if (!t) return false;
  return OBSERVED_AUTH_DEATH.test(t);
}

export function runnerChipState(input: RunnerChipInput, now: number = Date.now()): RunnerChipState {
  const name = input.runnerLabel || "This runner";

  if (input.installed === false) {
    return {
      tone: "missing",
      label: "Not installed",
      detail: `${name} is not installed on this machine.`,
      action: `Install ${name}, or pick a runner that is installed here.`,
      showsGreenTick: false,
    };
  }

  // 1. AN OBSERVED FAILURE OUTRANKS EVERY LOCAL VOUCH.
  //
  // This is the branch that was missing. `codex login status` can keep saying
  // the file is fine long after the provider stopped accepting the token —
  // the struct comment says so in as many words — so a real refusal must win
  // over a local opinion. Checked FIRST for exactly that reason.
  if (looksLikeAuthDeath(input.lastError)) {
    return {
      tone: "expired",
      label: "Sign-in expired",
      detail: `${name} reported that its sign-in is no longer accepted on this machine.`,
      action: `Sign ${name} in again on this machine.`,
      showsGreenTick: false,
    };
  }

  // 2. The agent's direct statement that there is no usable credential.
  if (input.authConfigured === false || input.needsAuth === true) {
    return {
      tone: "missing",
      label: "Not signed in",
      detail: `${name} is installed but not signed in on this machine — tasks sent to it will wait forever.`,
      action: `Sign ${name} in on this machine, or pick a runner that is signed in.`,
      showsGreenTick: false,
    };
  }

  // 3. PROVEN — the only path to a green tick.
  if (input.authVerified === true) {
    const at = input.authVerifiedAt;
    const stale = typeof at === "number" && at > 0 && now - at > VERIFIED_PROOF_TTL_MS;
    if (!stale) {
      return {
        tone: "verified",
        label: "Signed in",
        detail: null,
        action: null,
        showsGreenTick: true,
      };
    }
    // Proof has aged out. Not a failure — just no longer PROOF. Demote to the
    // same honest middle state rather than alarming the user.
    return {
      tone: "present",
      label: "Signed in · unverified",
      detail: `${name} last proved its sign-in over a day ago; nothing has exercised it since.`,
      action: null,
      showsGreenTick: false,
    };
  }

  // 4. VOUCHED BUT UNPROVEN. Real evidence, weaker than proof, and the state
  //    the live screenshot should have been in. No tick, and no nagging.
  if (input.authPresent === true || input.authConfigured === true) {
    return {
      tone: "present",
      label: "Signed in · unverified",
      detail: `${name} has a stored credential on this machine, but nothing has exercised it yet — a locally-valid token can still be rejected by the provider.`,
      action: null,
      showsGreenTick: false,
    };
  }

  // 5. Genuinely unknown — an older agent that ships none of these fields. Say
  //    so instead of guessing in either direction.
  return {
    tone: "unknown",
    label: "Sign-in unknown",
    detail: `${name}'s sign-in state was not reported by this machine.`,
    action: null,
    showsGreenTick: false,
  };
}
