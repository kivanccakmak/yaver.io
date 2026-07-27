// taskStreamWithRecovery.ts — package the reattach ladder so a call site gets
// it by CALLING, not by copying.
//
// `agentClient.streamTaskOutput` now reports `onEnd` and accepts `?since=`,
// and `taskStreamRecovery.ts` owns the policy (classify → reattach with
// bounded backoff → give up with a button). VibeCodingView wired all of that
// by hand inside a useEffect. Four other web call sites — PreviewPane,
// RuntimeLabView, WebReloadView (×2) and the dashboard page — passed no
// `onEnd` at all, so they kept the original defect: a severed relay tunnel or
// a dropped box froze the transcript on its last frame with a spinner over a
// task that was still running fine on the machine.
//
// Copying VibeCodingView's ~40 lines into four more components would have made
// five independently-drifting ladders for one policy — the same shape as the
// three drifting relay-auth matchers the audit already counts as a defect. So
// the ladder lives here once and the call sites pass callbacks.
//
// NO NEW POLICY. Classification, backoff and wording all still come from
// taskStreamRecovery.ts, which is parity-tested against its mobile twin.

import { classifyStreamEnd, planStreamRecovery } from "./taskStreamRecovery";

/** What a surface renders while the stream is not healthy. null = healthy. */
export type TaskStreamHealth = {
  kind: "reattaching" | "lost";
  message: string;
  /** Present on `lost` — the ROUTE. Calling it restarts the ladder. */
  reattach?: () => void;
} | null;

/** The subset of AgentClient this needs. Keeps the module testable and stops
 *  it from importing the whole client (and its Convex/type surface). */
export interface TaskStreamSource {
  streamTaskOutput(
    taskId: string,
    onChunk: (chunk: string) => void,
    onEvent?: (event: Record<string, unknown>) => void,
    opts?: {
      since?: number;
      onEnd?: (info: { sawDone: boolean; cancelled: boolean; error?: string }) => void;
    },
  ): () => void;
}

export interface TaskStreamRecoveryOptions {
  /** Called on every health transition, including back to null when a chunk
   *  proves the stream is alive again. A reattach the user cannot see is just
   *  a different silence. */
  onHealth?: (health: TaskStreamHealth) => void;
  /** Called when the agent replies `resume.full` — the box's transcript is
   *  SHORTER than ours (task re-created / output reset), so what follows
   *  REPLACES rather than appends. */
  onResumeFull?: () => void;
}

/**
 * Subscribe to a task's output with automatic, narrated reattach.
 *
 * Returns the stop function the call sites already store in their
 * `taskStreamStopRef`, so wiring a site is a one-line swap plus a banner.
 */
export function streamTaskOutputWithRecovery(
  client: TaskStreamSource,
  taskId: string,
  onChunk: (chunk: string) => void,
  onEvent?: (event: Record<string, unknown>) => void,
  options?: TaskStreamRecoveryOptions,
): () => void {
  // Bytes received from the STREAM — the offset the agent resumes from, so a
  // reattach replays only what we missed instead of the whole transcript.
  let received = 0;
  let attempt = 0;
  let disposed = false;
  let stop: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const health = (h: TaskStreamHealth) => options?.onHealth?.(h);

  const subscribe = (since: number) => {
    if (disposed) return;
    stop = client.streamTaskOutput(
      taskId,
      (chunk, offset) => {
        // Prefer the agent's authoritative byte cursor. Counting here means
        // counting UTF-16 code units, and `?since=` is sliced in BYTES — the
        // two agree only for ASCII, and a runner transcript is full of
        // box-drawing runes and "…". The local count stays as the fallback for
        // agents older than the `offset` field.
        if (typeof offset === "number") received = offset;
        else received += String(chunk || "").length;
        // A chunk means the stream is alive — clear any banner and reset the
        // ladder so the next outage starts at rung zero.
        attempt = 0;
        health(null);
        onChunk(chunk);
      },
      (event) => {
        if (event && (event as { type?: string }).type === "resume" && (event as { full?: boolean }).full === true) {
          received = 0;
          options?.onResumeFull?.();
        }
        onEvent?.(event as Record<string, unknown>);
      },
      {
        since,
        onEnd: (info) => {
          if (disposed) return;
          const plan = planStreamRecovery({
            end: classifyStreamEnd(info),
            attempt,
            cause: info.error,
          });
          if (plan.action === "idle") {
            health(null);
            return;
          }
          if (plan.action === "give-up") {
            health({ kind: "lost", message: plan.message, reattach: restart });
            return;
          }
          health({ kind: "reattaching", message: plan.message });
          attempt += 1;
          timer = setTimeout(() => subscribe(received), plan.delayMs);
        },
      },
    );
  };

  // The Reattach button's route: drop the dead subscription, reset the ladder,
  // and resume from where we actually stopped — never from zero, which would
  // replay a whole transcript the user has already read.
  const restart = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    stop?.();
    attempt = 0;
    health({ kind: "reattaching", message: "Reattaching to live output…" });
    subscribe(received);
  };

  subscribe(0);

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    stop?.();
    health(null);
  };
}
