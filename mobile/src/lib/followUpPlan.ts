// followUpPlan.ts — decide what sending a follow-up message actually does.
//
// Extracted from app/(tabs)/tasks.tsx for the same reason as
// probeTargets.ts and directProbeFailure.ts: the decision is pure, it is
// load-bearing, and it cannot be exercised from a test while it is buried in a
// 5000-line React component. `npx tsx` can run this without React Native.
//
// A follow-up is a turn in the task the user is already looking at. Completion
// ends a runner TURN, not the conversation. The old planner treated every
// completed/review task as dead and silently forked a child, so replying to
// Codex created both a new task id and a new runner session. That made Tasks a
// job launcher rather than a chat/vibing surface.
//
// Only the explicit New Task/Fork surfaces may create another task. This
// planner therefore has no fork action. A runner change is rejected here: two
// runners cannot share a native session format, and silently changing one
// would be the same cold-session bug under the original task id.

export type FollowUpAction =
  /** Resume the same task and native runner session in place. */
  | "continue"
  /** The picker differs from the task runner; use New Task explicitly. */
  | "runner-change-blocked"
  /** Adopted tmux session: input goes straight to the pane. */
  | "tmux-input";

export interface FollowUpPlan {
  action: FollowUpAction;
}

export interface FollowUpInput {
  isAdopted?: boolean;
  /** Runner recorded on the task when it started. */
  parentRunner?: string | null;
  /** Runner currently selected in the picker. */
  desiredRunner?: string | null;
  status?: string | null;
}

export function planFollowUp(input: FollowUpInput): FollowUpPlan {
  if (input.isAdopted) {
    return { action: "tmux-input" };
  }

  const parentRunner = (input.parentRunner || "").trim();
  const desiredRunner = (input.desiredRunner || "").trim();

  // A runner change only counts when we actually know BOTH sides. Treating an
  // unknown parent as "changed" would fork every legacy task on its first
  // follow-up, which is the loudest possible failure for the quietest cause.
  const runnerChanged = !!desiredRunner && !!parentRunner && desiredRunner !== parentRunner;
  if (runnerChanged) {
    return { action: "runner-change-blocked" };
  }
  return { action: "continue" };
}
