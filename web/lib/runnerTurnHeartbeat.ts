// runnerTurnHeartbeat.ts — "is the remote runner actually working?", as one line.
//
// WHY. The chat panel's status pill renders the task status: `RUNNING`. That is
// the INVENTORY. It reads identically one second and forty minutes into a turn,
// and identically again when the runner has stopped emitting anything at all —
// so the single question a user has while watching a remote AI work ("is it
// alive, or is it stuck?") had no answer on screen. Reported from the live web
// UI on 2026-08-03, with the preview lane one pane over narrating itself
// perfectly ("webview/transport · streaming · 62% · 3:53 elapsed · last output
// 4s ago"). The runner lane deserves the same courtesy and no more.
//
// THE SHAPE, and why it is this small. CLAUDE.md: every wait the product imposes
// must narrate itself — what is running, how long, when it last made progress —
// and a control surface accretes chips until the thing you came for is buried.
// So: ONE line, three facts, one action, and only while the turn is live. No
// spinner, no second badge, no progress bar (there is no honest percentage for a
// coding turn — inventing one would be worse than omitting it).
//
// It is a pure function in lib/ on purpose: the logic that SHIPS is the logic
// that is TESTED (runnerTurnHeartbeat.test.mts), and every other surface —
// mobile, tvOS, watch — needs the same sentence and must not re-derive it.

// RELATION TO mobile/src/lib/laneProgress.ts — deliberate, not drift.
// That file is the same rule for the BUILD lane ("2:14 elapsed · last output 3s
// ago"), and the grammar here matches it on purpose so one product does not
// speak two dialects about the same kind of wait. Two things differ, both
// because the subject differs:
//   • the threshold is 90s here, not 45s — a coding runner is legitimately
//     silent through a long tool call, and a wait UI that cries wolf at 45s
//     teaches the user to ignore the one field that carries information;
//   • the quiet line does NOT say "this may be stalled". For a compile, stalled
//     is a fair guess. For a runner turn it is a guess about someone else's
//     machine that we have not measured, and it would send the user to fix
//     something that is thinking.

/** How long output can be absent before the line says so instead of implying
 *  progress. Deliberately generous — see the note above. */
export const RUNNER_QUIET_THRESHOLD_MS = 90_000;

export type RunnerTurnPhase = "starting" | "working" | "quiet";

export type RunnerTurnHeartbeat = {
  phase: RunnerTurnPhase;
  /** The whole line, ready to render. */
  text: string;
  /** True when the user should be able to end the turn from here. */
  canStop: boolean;
  /** True when the line is reporting an absence of output — render it in a
   *  warning tone, never as an error. A quiet runner is usually thinking. */
  warn: boolean;
};

export type RunnerTurnInput = {
  /** "queued" | "running" | anything else (which produces null). */
  status?: string | null;
  /** Display name of the runner: "opencode", "Claude Code". */
  runnerName?: string | null;
  startedAt: number;
  lastOutputAt: number;
  now: number;
  /** True once any output has arrived; a queued turn has none yet. */
  hasOutput?: boolean;
};

/** m:ss, or h:mm:ss past an hour. Matches the build heartbeat's format so the
 *  two rows in one panel never disagree about how to print a minute. */
export function formatTurnElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** "4s", "2m 10s" — the age of the last thing the runner said. */
export function formatOutputAge(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/**
 * describeRunnerTurn returns the line to render, or null when there is nothing
 * honest to say — which is most of the time. Returning null for a finished turn
 * is the point: a heartbeat that outlives the turn it describes is a lie in the
 * one place the user has decided to trust.
 */
export function describeRunnerTurn(input: RunnerTurnInput): RunnerTurnHeartbeat | null {
  const status = String(input.status || "").toLowerCase();
  if (status !== "queued" && status !== "running") return null;

  const who = (input.runnerName || "").trim() || "The runner";
  const elapsed = formatTurnElapsed(input.now - input.startedAt);

  // A queued turn has not started producing yet. Saying "last output 0s ago"
  // there would claim output that does not exist.
  if (status === "queued" || input.hasOutput === false) {
    return {
      phase: "starting",
      text: `${who} is starting · ${elapsed} elapsed`,
      canStop: true,
      warn: false,
    };
  }

  const quietFor = Math.max(0, input.now - input.lastOutputAt);
  if (quietFor >= RUNNER_QUIET_THRESHOLD_MS) {
    // Deliberately NOT "stalled" or "stuck". We know one fact — nothing has
    // arrived for a while — and naming a cause we have not measured is how a
    // user gets sent to fix a machine that is working. Stating the silence is
    // enough; the Stop button is right there if they decide it is too long.
    return {
      phase: "quiet",
      text: `${who} is working · ${elapsed} elapsed · no output for ${formatOutputAge(quietFor)}`,
      canStop: true,
      warn: true,
    };
  }

  return {
    phase: "working",
    text: `${who} is working · ${elapsed} elapsed · last output ${formatOutputAge(quietFor)} ago`,
    canStop: true,
    warn: false,
  };
}
