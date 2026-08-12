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
    /** `offset` is the agent's authoritative byte cursor for `?since=`; it is
     *  optional because an agent older than that field does not send it. */
    onChunk: (chunk: string, offset?: number) => void,
    onEvent?: (event: Record<string, unknown>) => void,
    opts?: {
      since?: number;
      /** Byte offset into the task's RAW stdout tail already rendered —
       *  resume the opencode terminal view (`?rawSince=`) without
       *  re-rendering bytes. See AgentClient.streamTaskOutput. */
      rawSince?: number;
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
  /** Byte offset into the task's RAW stdout tail this caller already
   *  rendered (opencode terminal view). Drives the `?rawSince=` resume on
   *  every (re)subscribe; 0/absent starts the raw replay from the retained
   *  tail head. */
  rawSince?: number;
  /** Receives RAW runner stdout (ANSI + TUI, ungroomed) — the opencode
   *  console lane, the same bytes mobile's LiveConsoleSection renders.
   *  `{type:"raw_replay", text}` is the reattach snapshot; `{type:"raw",
   *  text}` is live. Threaded to AgentClient.streamTaskOutput; absent on web
   *  chat was the parity gap of docs/audits/webui-chat-vibing-gui-2026-08-12.md
   *  §2 (web had no consumer for a lane mobile ships). */
  onRaw?: (event: { type: "raw" | "raw_replay"; text?: string; offset?: number }) => void;
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
  // Bytes of RAW stdout the terminal view already rendered. Updated from the
  // authoritative `raw_replay.offset` / `raw.offset` frames; passed as
  // `?rawSince=` on every subscribe so an opencode terminal reattaches
  // without re-rendering its scrollback.
  let rawReceived = options?.rawSince ?? 0;
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
        const ev = event as { type?: string; offset?: number; [k: string]: unknown };
        if (ev.type === "resume" && ev.full === true) {
          received = 0;
          options?.onResumeFull?.();
        }
        // Authoritative raw byte cursor — the terminal view's resume offset.
        // Also lets a raw_replay full-snapshot reset the cursor so a
        // re-subscribe never requests a since that's past the retained tail.
        if ((ev.type === "raw_replay" || ev.type === "raw") && typeof ev.offset === "number") {
          rawReceived = ev.offset;
        }
        // Raw stdout (ANSI + TUI) goes to the dedicated consumer, not onEvent:
        // the event bus is for protocol frames, and a raw lane riding it would
        // make every consumer re-classify bytes. Mirrors mobile's onRaw.
        if ((ev.type === "raw" || ev.type === "raw_replay") && options?.onRaw) {
          options.onRaw({
            type: ev.type,
            text: typeof ev.text === "string" ? ev.text : undefined,
            offset: typeof ev.offset === "number" ? ev.offset : undefined,
          });
          return; // raw frames are consumed here; don't also hit onEvent
        }
        onEvent?.(ev);
      },
      {
        since,
        rawSince: rawReceived,
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
