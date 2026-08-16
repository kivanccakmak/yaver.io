// capabilityGapFix.ts — RUN the route a CapabilityGap carries, and narrate it.
//
// capabilityGap.ts is pure (and byte-identical with its web twin); this is the
// mobile-side driver that turns `fix.{method,path,stream}` into: POST the
// path → subscribe the stream → push every line to the surface the user is
// looking at → re-issue the original operation when the install reports ok.
//
// CLAUDE.md, "streaming the fix is part of the fix": a 1.2 GB SDK behind a
// silent spinner is the same defect as a silent `serve` — the user cannot tell
// fetching from hung. So this always reports elapsed time alongside the last
// line, even while the download is quiet.
//
// Both mobile browser-preview implementations (app/(tabs)/apps.tsx and
// src/components/DevPreview.tsx) use this ONE driver. Two copies is exactly how
// the same lane shipped a broken heartbeat on one screen and a working one on
// the other.

import type { CapabilityGap } from "./capabilityGap";
import { gapInstallTool, gapRetriesAfterFix } from "./capabilityGap";

/** The slice of the agent client this needs. Kept structural so both screens
 *  can pass whichever client instance they already hold. */
export type CapabilityGapFixClient = {
  installTool(tool: string, target?: string): Promise<{ ok: boolean; tool: string; stream: string; error?: string }>;
  subscribeStream(
    name: string,
    onLine: (text: string) => void,
    onResult?: (status: string, error?: string) => void,
    onEvent?: (event: unknown) => void,
  ): () => void;
};

export type CapabilityGapFixHandlers = {
  /** Every line of the fix's output, in order. */
  onLine: (line: string) => void;
  /** Called once. `ok` true ⇒ the caller should re-run the original operation
   *  when gapRetriesAfterFix(gap). */
  onDone: (ok: boolean, error?: string) => void;
};

/** Human "2:14 elapsed" for a fix that has been running a while. */
export function formatFixElapsed(startedAt: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")} elapsed` : `${s}s elapsed`;
}

/**
 * Start the gap's fix. Returns a cancel function that stops streaming (it does
 * NOT abort the install on the box — the agent owns that, and killing a
 * half-written SDK is worse than letting it finish).
 *
 * Refuses, loudly, when the gap carries no route: a button that silently does
 * nothing is worse than no button.
 */
export function runCapabilityGapFix(
  client: CapabilityGapFixClient,
  gap: CapabilityGap,
  handlers: CapabilityGapFixHandlers,
): () => void {
  const tool = gapInstallTool(gap);
  if (!tool) {
    handlers.onDone(false, gap.constraint || "This gap carries no install route.");
    return () => {};
  }

  let cancelled = false;
  let cancelStream: (() => void) | null = null;

  (async () => {
    handlers.onLine(`POST ${gap.fix!.path} …`);
    let started: { ok: boolean; stream: string; error?: string };
    try {
      started = await client.installTool(tool);
    } catch (e) {
      handlers.onDone(false, e instanceof Error ? e.message : String(e));
      return;
    }
    if (cancelled) return;
    if (!started.ok) {
      // Name the endpoint that refused. "Install failed" with no path is the
      // vague-error cost this whole seam exists to remove.
      handlers.onDone(false, `${gap.fix!.path} refused: ${started.error || "unknown error"}`);
      return;
    }
    // The agent names the stream in its 202; prefer that over our copy so a
    // server-side rename cannot leave us subscribed to nothing.
    const streamName = started.stream || gap.fix!.stream;
    handlers.onLine(`streaming /streams/${streamName}`);
    cancelStream = client.subscribeStream(
      streamName,
      (line) => {
        if (!cancelled) handlers.onLine(line);
      },
      (status, error) => {
        if (cancelled) return;
        cancelStream?.();
        handlers.onDone(status === "ok", status === "ok" ? undefined : error || "install failed");
      },
    );
  })();

  return () => {
    cancelled = true;
    cancelStream?.();
  };
}

export { gapRetriesAfterFix };
