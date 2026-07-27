/**
 * runnerLaunchGate — "should clicking Codex open the terminal, or ask for a login?"
 *
 * THE BUG THIS REPLACES (2026-07-27, web dashboard → Devices → click Codex on a
 * remote Linux box): the modal sat on "CHECKING RUNNER AUTH · 12s" and kept
 * counting while the PTY stayed closed. The gate was calling
 * `POST /agent/runners/test`, which for codex spawns
 *
 *     codex exec --dangerously-bypass-approvals-and-sandbox … "Reply with OK"
 *
 * — i.e. a REAL gpt-5.4 inference round trip. Measured on the live box:
 * 5.3 s and 6,212 tokens of the user's paid quota, PER CLICK, plus relay RTT,
 * with a 20 s client budget on top. Meanwhile `/runner-auth/status` on the same
 * box answered in 0.20 s with `authVerified: true, authSource: "codex login
 * status"` — the answer was already known, for free, before the click.
 *
 * Three separate defects in one:
 *   1. It blocked the terminal on a check whose answer the device row ALREADY
 *      carried (`device.runners[].authVerified`, shipped in a63d16ead).
 *   2. It paid for that answer in the user's LLM quota, every single click.
 *   3. It could only END in "allowed" or "Runner needs attention" — there was
 *      no path where a slow or unavailable check still gets you a terminal.
 *
 * THE CONTRACT THIS IMPLEMENTS
 *   - Known-good  → OPEN NOW. A device row that says installed + authVerified
 *     is proof; re-proving it is the user's money and the user's time. Any
 *     deeper check runs in the BACKGROUND, over the already-open PTY.
 *   - Known-bad   → SIGN IN. Route straight into the runner OAuth flow. Never
 *     probe first to rediscover what the row already said.
 *   - Unknown     → VERIFY, BOUNDED. A few seconds against the cheap
 *     `/runner-auth/status` route (no tokens, no subprocess generation), with
 *     elapsed narrated.
 *   - Timed out / check failed → OPEN ANYWAY, with a NAMED banner. Failing
 *     open is correct here: this is an ssh-shaped session with the runner's
 *     bypass-permissions flag. A terminal that says "we could not confirm X"
 *     is strictly more useful than a spinner that says nothing, and the runner
 *     TUI will state its own login need in the pane if there is one.
 *
 * The whole point is that NO input combination returns "keep spinning". The
 * only state that waits is `verify`, and it is bounded by `budgetMs` — past
 * that the function itself hands back `open-degraded`. See the exhaustiveness
 * test in runnerLaunchGate.test.ts.
 */

/** Runners whose launch is gated at all. Everything else opens unconditionally. */
export type GatedRunner = "claude" | "codex";

/** How long we are willing to make the user wait for a verdict we don't have. */
export const RUNNER_VERIFY_BUDGET_MS = 4_000;

/**
 * Minimal structural shape of `Device["runners"][n]`. Declared locally so the
 * decision function stays pure and testable without importing the Convex-facing
 * Device type (and so a field rename there fails loudly here).
 */
export interface RunnerStatusRow {
  /** Convex heartbeat rows (`device.runners`) key the runner as `runnerId`… */
  runnerId?: string;
  /** …while `/runner-auth/status` rows key it as `id`. Accept both rather than
   *  making every caller remember which shape it is holding — getting this
   *  wrong reads as "the agent reported no row" and fails us open for nothing. */
  id?: string;
  status?: string;
  ready?: boolean;
  installed?: boolean;
  authConfigured?: boolean;
  authVerified?: boolean;
  authSource?: string;
  warning?: string;
  error?: string;
}

/** Outcome of the cheap live check, once it has resolved. */
export type RunnerProbeOutcome =
  | { state: "verified"; authSource?: string }
  | { state: "needs-auth"; reason: string }
  | { state: "error"; reason: string };

export interface RunnerLaunchGateInput {
  /** undefined / "opencode" / "shell" → not gated. */
  runner?: string;
  /** Rows from the device's last heartbeat (Convex). May be missing entirely. */
  deviceRunners?: RunnerStatusRow[] | null;
  /** Result of the live `/runner-auth/status` check; null while in flight. */
  probe?: RunnerProbeOutcome | null;
  /** Wall-clock since the gate opened. */
  elapsedMs: number;
  budgetMs?: number;
}

export type RunnerLaunchDecision =
  /** Mount the PTY now. */
  | { kind: "open"; via: "ungated" | "device-verified" | "probe-verified"; detail: string }
  /** Mount the PTY now, but render `banner` above it — we could not confirm. */
  | { kind: "open-degraded"; via: "budget-exhausted" | "check-failed" | "not-installed"; banner: string }
  /** Route into the runner sign-in flow. PTY stays closed. */
  | { kind: "sign-in"; reason: string }
  /** Still checking — bounded. Callers render elapsed/remaining, never a bare spinner. */
  | { kind: "verify"; elapsedSec: number; remainingSec: number; detail: string };

export function isGatedRunner(runner?: string): runner is GatedRunner {
  return runner === "claude" || runner === "codex";
}

function normalizeRunnerId(id: string): string {
  const v = String(id || "").trim().toLowerCase();
  if (v === "claude-code" || v === "claudecode") return "claude";
  return v;
}

/** The row for `runner`, or undefined when the heartbeat carried no opinion. */
export function findRunnerRow(
  rows: RunnerStatusRow[] | null | undefined,
  runner: string,
): RunnerStatusRow | undefined {
  const want = normalizeRunnerId(runner);
  if (!want) return undefined;
  for (const row of rows || []) {
    const id = normalizeRunnerId(String(row?.runnerId || row?.id || ""));
    if (id === want) return row;
  }
  return undefined;
}

function runnerLabel(runner: string): string {
  return runner === "claude" ? "Claude" : runner === "codex" ? "Codex" : runner;
}

/**
 * Does the heartbeat row itself say this runner is signed out?
 *
 * Deliberately narrow: only an EXPLICIT negative counts. `authConfigured`
 * being absent means the agent is older than a63d16ead, not that the user is
 * logged out — treating silence as "no" is how you send a signed-in user to a
 * login screen.
 */
function rowSaysSignedOut(row: RunnerStatusRow): boolean {
  if (row.authConfigured === false) return true;
  const reported = String(row.status || "").trim().toLowerCase().replace("_", "-");
  return reported === "needs-auth";
}

/**
 * The single decision the modal renders. Pure: same inputs → same output, no
 * clock, no network. `elapsedMs` is passed in precisely so the "have we run out
 * of patience" rule is testable rather than living in a setTimeout.
 */
export function decideRunnerLaunchGate(input: RunnerLaunchGateInput): RunnerLaunchDecision {
  const { runner, deviceRunners, probe, elapsedMs } = input;
  const budgetMs = input.budgetMs ?? RUNNER_VERIFY_BUDGET_MS;

  // 0 — Not an auth-sensitive runner (plain shell, opencode, tmux attach).
  // Never gated; there is nothing to sign into.
  if (!isGatedRunner(runner)) {
    return { kind: "open", via: "ungated", detail: "This session does not depend on a runner login." };
  }
  const label = runnerLabel(runner);
  const row = findRunnerRow(deviceRunners, runner);

  // 1 — FAST PATH. The device row already proves it. This is the case the user
  // hits every day and it must cost zero network and zero tokens.
  //
  // `ready === false` vetoes even a verified credential: a runner can hold a
  // good token and still be unrunnable (codex with the Linux userns sandbox
  // blocked is the shipped example), and that shows up as ready:false + error.
  if (row && row.authVerified === true && row.installed !== false && row.ready !== false) {
    return {
      kind: "open",
      via: "device-verified",
      detail: row.authSource
        ? `${label} is signed in on this machine (${row.authSource}).`
        : `${label} is signed in on this machine.`,
    };
  }

  // 2 — Known bad, from the row alone. Route to sign-in immediately; do not
  // spend seconds rediscovering it.
  if (row && rowSaysSignedOut(row)) {
    return {
      kind: "sign-in",
      reason:
        String(row.error || row.warning || "").trim() ||
        `${label} is not signed in on this machine.`,
    };
  }

  // 3 — Not installed. Not a login problem, so sign-in would be a lie; but it
  // is also not a reason to withhold a terminal (the user may want to install
  // it right there). Open, and NAME the gap — never a bare "not ready".
  if (row && row.installed === false) {
    return {
      kind: "open-degraded",
      via: "not-installed",
      banner:
        String(row.error || row.warning || "").trim() ||
        `${label} is not installed on this machine — the terminal is open, but the ${label} command will not be found.`,
    };
  }

  // 4 — A resolved live check beats everything below.
  if (probe) {
    if (probe.state === "verified") {
      return {
        kind: "open",
        via: "probe-verified",
        detail: probe.authSource
          ? `${label} confirmed signed in (${probe.authSource}).`
          : `${label} confirmed signed in.`,
      };
    }
    if (probe.state === "needs-auth") {
      return { kind: "sign-in", reason: probe.reason || `${label} is not signed in on this machine.` };
    }
    // The check itself broke (route missing on an older agent, relay hiccup,
    // HTTP error). That says nothing about the runner — fail OPEN and say so.
    return {
      kind: "open-degraded",
      via: "check-failed",
      banner: `Could not confirm ${label}'s login on this machine (${probe.reason}). Opening the terminal anyway — ${label} will prompt for sign-in itself if it needs to.`,
    };
  }

  // 5 — Out of patience. The bound lives HERE, not in a timer, so it cannot be
  // lost by a cancelled effect. This is the state that used to be an unbounded
  // spinner.
  if (elapsedMs >= budgetMs) {
    return {
      kind: "open-degraded",
      via: "budget-exhausted",
      banner: `${label}'s login could not be confirmed within ${Math.round(budgetMs / 1000)}s. Opening the terminal anyway — ${label} will prompt for sign-in itself if it needs to.`,
    };
  }

  // 6 — Genuinely still checking, and still worth waiting for.
  return {
    kind: "verify",
    elapsedSec: Math.max(0, Math.round(elapsedMs / 1000)),
    remainingSec: Math.max(0, Math.ceil((budgetMs - elapsedMs) / 1000)),
    detail: `Confirming ${label}'s login on this machine.`,
  };
}

/** True when the decision means "the PTY should be mounted right now". */
export function decisionOpensTerminal(d: RunnerLaunchDecision): boolean {
  return d.kind === "open" || d.kind === "open-degraded";
}

/**
 * Map a `/runner-auth/status` row onto a probe outcome.
 *
 * Note the asymmetry, and that it is deliberate: `authVerified === true` is the
 * only thing that counts as verified, but `authConfigured === false` is the
 * only thing that counts as needs-auth. Everything in between is "error" —
 * i.e. we fail OPEN. That is the opposite of the old gate, which treated every
 * non-pass as "Runner needs attention".
 */
export function probeFromStatusRow(
  row: RunnerStatusRow | undefined,
  runner: string,
): RunnerProbeOutcome {
  const label = runnerLabel(runner);
  if (!row) return { state: "error", reason: `the agent reported no ${label} row` };
  if (row.installed === false) {
    return { state: "error", reason: String(row.error || row.warning || `${label} is not installed`) };
  }
  if (row.authVerified === true && row.ready !== false) return { state: "verified", authSource: row.authSource };
  if (row.authConfigured === false) {
    return { state: "needs-auth", reason: String(row.error || row.warning || `${label} is not signed in`) };
  }
  if (row.ready === false) {
    return { state: "error", reason: String(row.error || row.warning || `${label} reported not ready`) };
  }
  return { state: "error", reason: `${label}'s login was found but not confirmed` };
}
