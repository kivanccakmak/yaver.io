/**
 * runnerChannel.ts — AgentChannelAdapter that commits one complete instruction
 * to the LIVE remote runner session (claude code / codex / opencode) the user
 * already has running, via POST /runner/session/turn.
 *
 * Per the product owner: handle the conversation with the real coding runner on
 * the remote box, NOT a separate cloud voice pipeline (no Flux, no second bill).
 * The runner is the user's own Claude Max / ChatGPT Plus session on their own
 * machine — paid once, to them.
 *
 * All the hard parts — mapping a spoken "yes"/"one" to a menu digit, never
 * reading code aloud, clamping the pane to one spoken sentence, never throwing —
 * already live in carSessionTurn.ts (pure + tsx-tested). This adapter is a thin
 * shell over dispatchSessionTurn so that logic is shared, not re-implemented.
 */
import type { AgentChannelAdapter, AgentReply, TurnContext } from "../types";
import {
  dispatchSessionTurn,
  parseSpokenChoice,
  type SessionTurnDep,
} from "../../carSessionTurn";

export interface RunnerChannelDeps {
  /** Drives one session turn on the box. In production this wraps
   *  quicClient.runnerSessionTurn(deviceId, text, choice). */
  sessionTurn: SessionTurnDep;
}

export function createRunnerChannel(deps: RunnerChannelDeps): AgentChannelAdapter {
  // Session selection is per-conversation client state. Remember the original
  // instruction and replay it only after the driver names a target. The old
  // flow read a picker aloud, then sent the next number as a runner-menu choice.
  let pendingSession: {
    instruction: string;
    choices: Array<{ name: string; runner: string; index: number }>;
  } | null = null;

  return {
    async send(instruction: string, ctx: TurnContext): Promise<AgentReply> {
      if (pendingSession) {
        const digit = parseSpokenChoice(instruction);
        const picked = digit
          ? pendingSession.choices.find((choice) => choice.index === Number(digit) - 1)
          : undefined;
        if (!picked) {
          return {
            spoken: `Say a session number from one to ${pendingSession.choices.length}.`,
            awaitingChoice: true,
            options: pendingSession.choices.map((choice) => `${choice.index + 1}. ${choice.runner} ${choice.name}`),
          };
        }
        const original = pendingSession.instruction;
        pendingSession = null;
        const selected = await dispatchSessionTurn(original, deps.sessionTurn, false, picked.name);
        if (selected.available?.length) {
          pendingSession = { instruction: original, choices: selected.available };
        }
        return {
          spoken: selected.spoken,
          awaitingChoice: selected.awaitingChoice,
          options: selected.options,
          error: selected.error,
        };
      }

      const r = await dispatchSessionTurn(
        instruction,
        deps.sessionTurn,
        ctx.pendingChoice,
      );
      if (r.available?.length) {
        pendingSession = { instruction, choices: r.available };
      }
      return {
        spoken: r.spoken,
        awaitingChoice: r.awaitingChoice,
        options: r.options,
        error: r.error,
      };
    },
  };
}
