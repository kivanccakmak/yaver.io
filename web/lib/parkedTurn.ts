// parkedTurn.ts — web's half of the "your words were kept" contract.
//
// Native surfaces cannot import mobile/src/lib/*, so this is a deliberate port of
// mobile/src/lib/parkedTurn.ts rather than a shared module. The thing that keeps the
// two from drifting is that both key off the SAME reason codes
// (desktop/agent/reason_codes.go) — never off prose. Mobile already carries three
// divergent relay-auth regexes, none a superset of the others; that is what happens
// when surfaces match sentences instead of codes.
//
// Context: 2026-08-02 audit. A follow-up typed against a runner whose credential had
// gone stale used to be spent on a doomed spawn and lost. The agent now parks the
// prompt and replays it on recovery — which is only worth anything if the surface
// says so, because a user told "failed" will retype and then the prompt runs twice.

export const RUNNER_AUTH_CODES = {
  lineageLost: "runner.codex.refresh_lineage_lost",
  credentialExpired: "runner.codex.credential_expired",
  /** Host blocks the Linux sandbox — NOT auth, so no sign-in button. */
  linuxSandboxBlocked: "runner.codex.linux_sandbox_blocked",
  credentialIsCopy: "runner.codex.credential_is_copy",
  credentialCorrupt: "runner.codex.credential_corrupt",
  notAuthenticated: "runner.codex.not_authenticated",
  refreshFailed: "runner.codex.refresh_failed",
} as const;

/** The 409 body from POST /tasks/{id}/continue. */
export interface ParkedTurnRejection {
  ok: false;
  taskId: string;
  code?: string;
  error?: string;
  parked?: boolean;
  reauthable?: boolean;
  runner?: string;
}

/** Thrown by continueTask when the prompt was parked rather than spent. */
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
 * One honest line, and a button only when there is something worth pressing.
 * Offering an action that cannot help is worse than offering none.
 */
export function parkedTurnNotice(err: ParkedTurnError): {
  line: string;
  action: { label: string; kind: "signin" } | null;
} {
  const runner = err.runner === "codex" ? "Codex" : err.runner || "the runner";

  switch (err.code) {
    case RUNNER_AUTH_CODES.linuxSandboxBlocked:
      // Actionless on purpose: the fix is host kernel config, not a sign-in.
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
      return {
        line: `Message saved — waiting for ${runner} to be reachable. It will send on its own.`,
        action: null,
      };
  }
}
