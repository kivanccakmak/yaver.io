// parkedTurn.ts — the surface contract for "your words were kept".
//
// WHY THIS TYPE EXISTS. On 2026-08-02 the user, on holiday, finished a task on a
// remote box and typed a follow-up to keep going in the same session. Codex's
// credential had gone stale, so the follow-up was spent on a spawn that could only
// 401 — and the words were gone. Re-authenticating worked, and still did not bring
// the turn back, because nothing had kept it.
//
// The agent now parks the prompt instead of burning it and replays it automatically
// once the credential recovers (desktop/agent/task_parked_turn.go). That is only
// worth anything if the surface SAYS SO: a user who is told "failed" will retype,
// and then the same prompt runs twice.
//
// KEY OFF `code`, NOT PROSE. Mobile already carries three different relay-auth
// regexes, none a superset of the others, and they drift every time a sentence is
// reworded. These codes are the wire contract (desktop/agent/reason_codes.go).

/** Reason codes the agent returns when a follow-up cannot run yet. */
export const RUNNER_AUTH_CODES = {
  /** The refresh token was consumed or revoked — only a fresh sign-in fixes it. */
  lineageLost: "runner.codex.refresh_lineage_lost",
  /** A credential IS here and its access token is past expiry. */
  credentialExpired: "runner.codex.credential_expired",
  /** The host blocks the Linux sandbox Codex needs. NOT an auth problem — a
   *  sign-in button here would be a button that cannot help. */
  linuxSandboxBlocked: "runner.codex.linux_sandbox_blocked",
  /** This box's credential is a copy of another machine's; it must not be renewed here. */
  credentialIsCopy: "runner.codex.credential_is_copy",
  /** auth.json is empty/unparseable — a write was interrupted (usually an OOM kill). */
  credentialCorrupt: "runner.codex.credential_corrupt",
  /** Not signed in at all. */
  notAuthenticated: "runner.codex.not_authenticated",
  /** Transient renewal failure; the credential itself is still fine. */
  refreshFailed: "runner.codex.refresh_failed",
} as const;

export type RunnerAuthCode = (typeof RUNNER_AUTH_CODES)[keyof typeof RUNNER_AUTH_CODES];

/** The 409 body from POST /tasks/{id}/continue. */
export interface ParkedTurnRejection {
  ok: false;
  taskId: string;
  code?: string;
  error?: string;
  /** True when the agent kept the user's prompt and will replay it on recovery. */
  parked?: boolean;
  /** True when a human sign-in is the only remaining fix. */
  reauthable?: boolean;
  runner?: string;
}

/**
 * Thrown by continueTask when the prompt was parked. Carries everything a surface
 * needs to render one honest line and one button — and nothing more. A parked turn
 * is not an error the user must act on immediately; it is a promise being kept.
 */
export class ParkedTurnError extends Error {
  readonly parked = true;
  readonly code?: string;
  readonly reauthable: boolean;
  readonly runner: string;
  readonly taskId: string;

  constructor(rejection: ParkedTurnRejection) {
    super(rejection.error || "Your message is waiting for the runner to be signed in again.");
    this.name = "ParkedTurnError";
    this.code = rejection.code;
    this.reauthable = rejection.reauthable === true;
    this.runner = rejection.runner || "";
    this.taskId = rejection.taskId;
  }
}

/**
 * The sentence to render beside a parked turn.
 *
 * Deliberately short and non-alarming. The user does not need the mechanism — they
 * need to know (a) their words are safe, (b) whether anything is required of them.
 * Everything else belongs one tap deeper, per the LESS IS MORE rule.
 */
export function parkedTurnNotice(err: ParkedTurnError): {
  line: string;
  action: { label: string; kind: "signin" } | null;
} {
  const runner = err.runner === "codex" ? "Codex" : err.runner ? err.runner : "the runner";

  switch (err.code) {
    case RUNNER_AUTH_CODES.linuxSandboxBlocked:
      // Deliberately actionless: the fix is host kernel configuration, not a
      // sign-in. Offering "Sign in" here would send the user through an OAuth
      // flow that completes successfully and changes nothing.
      return {
        line: `Message saved — this machine is blocking the sandbox ${runner} needs to run. It will send once that's fixed on the host.`,
        action: null,
      };
    case RUNNER_AUTH_CODES.lineageLost:
    case RUNNER_AUTH_CODES.notAuthenticated:
    case RUNNER_AUTH_CODES.credentialExpired:
    case RUNNER_AUTH_CODES.credentialCorrupt:
      return {
        line: `Message saved — ${runner} needs to be signed in on this machine. It will send by itself once you're back in.`,
        action: { label: `Sign in to ${runner}`, kind: "signin" },
      };
    case RUNNER_AUTH_CODES.credentialIsCopy:
      return {
        line: `Message saved — this machine is using a copy of another machine's ${runner} login, which can't be renewed here. Sign in on this machine and it will send.`,
        action: { label: `Sign in to ${runner}`, kind: "signin" },
      };
    default:
      // Transient / unknown: no action, because there is nothing useful for the
      // user to press. Offering a button that cannot help is worse than none.
      return {
        line: `Message saved — waiting for ${runner} to be reachable. It will send on its own.`,
        action: null,
      };
  }
}
