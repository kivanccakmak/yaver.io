"use client";

// ScreenContextChip — the visible, switchable half of "the agent knows which
// screen you're looking at".
//
// ── Why this is a component and not three hooks inside RuntimeLabView ──────
//
// It does the whole loop in one place: listen for the preview probe's
// postMessage, forward it to the agent over the authenticated channel, show the
// user exactly what got attached, and let them turn it off. Any surface with a
// preview iframe and a composer can mount it with one line — RuntimeLabView,
// PreviewPane, VibeCodingView — and none of them can implement half of it.
//
// ── The rule this exists to satisfy ───────────────────────────────────────
//
// SILENT PROMPT MUTATION IS A DEFECT. The agent prepends a block describing the
// user's screen to the prompt they typed. If the user cannot see that happening
// and cannot stop it, we have built exactly the kind of hidden behaviour this
// repo treats as a bug — the UI equivalent of a `serve` that logs nothing.
// So the chip states the screen BY NAME ("Adın ne? (3 controls)"), expands to
// the literal facts being sent, and the toggle does not merely stop future
// posts: it DELETES what was already reported, so "off" means the agent is not
// holding your screen rather than holding it and promising not to look.

import { useCallback, useEffect, useRef, useState } from "react";

import type { AgentClient } from "@/lib/agent-client";
import {
  type ScreenContext,
  isScreenContextEnabled,
  parseScreenContextMessage,
  sameScreenContext,
  screenContextDetail,
  screenContextSummary,
  setScreenContextEnabled,
} from "@/lib/screenContext";

/** Re-post an unchanged screen this often so the agent's freshness window
 *  (screenContextTTL, 3 min) cannot lapse while the user sits on one screen
 *  composing a prompt. Comfortably inside it. */
const HEARTBEAT_MS = 60_000;

export function ScreenContextChip({
  agentClient,
  workDir,
  className = "",
}: {
  agentClient: AgentClient | null;
  /** Project root the preview belongs to. The agent keys screen context by it;
   *  without it there is nothing to attach the observation to. */
  workDir?: string | null;
  className?: string;
}) {
  const [ctx, setCtx] = useState<ScreenContext | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const lastSent = useRef<ScreenContext | null>(null);
  const lastSentAt = useRef(0);

  // Read the stored preference on mount only — localStorage is not available
  // during SSR, and reading it in render would desync hydration.
  useEffect(() => setEnabled(isScreenContextEnabled()), []);

  const forward = useCallback(
    (next: ScreenContext) => {
      if (!agentClient || !workDir) return;
      const now = Date.now();
      if (sameScreenContext(next, lastSent.current) && now - lastSentAt.current < HEARTBEAT_MS) return;
      lastSent.current = next;
      lastSentAt.current = now;
      void agentClient.reportScreenContext({ ...next, workDir });
    },
    [agentClient, workDir],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onMessage = (ev: MessageEvent) => {
      // No origin check, on purpose and safely: the preview frame is a
      // different origin by construction (the agent's relay URL), so pinning an
      // origin here would reject the only sender we want. The defence is the
      // validating parser — unknown shapes return null, every string is
      // clamped, `lane` is an allowlist — plus the agent re-normalising on
      // receipt. See screenContext.ts for the trust note.
      const parsed = parseScreenContextMessage(ev.data);
      if (!parsed) return;
      setCtx(parsed);
      if (isScreenContextEnabled()) forward(parsed);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [forward]);

  // Switching projects must not carry the previous project's screen along.
  useEffect(() => {
    setCtx(null);
    lastSent.current = null;
    lastSentAt.current = 0;
  }, [workDir]);

  const toggle = useCallback(() => {
    const next = !enabled;
    setEnabled(next);
    setScreenContextEnabled(next);
    if (!next) {
      lastSent.current = null;
      lastSentAt.current = 0;
      if (agentClient && workDir) void agentClient.clearScreenContext(workDir);
    } else if (ctx) {
      forward(ctx);
    }
  }, [enabled, agentClient, workDir, ctx, forward]);

  // Nothing observed yet: render nothing rather than an empty promise. A chip
  // reading "context: —" would assert a capability that is not currently doing
  // anything.
  if (!ctx) return null;

  const summary = screenContextSummary(ctx);
  if (!summary) return null;
  const detail = screenContextDetail(ctx);

  return (
    <div
      className={`flex flex-col gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] leading-4 ${
        enabled
          ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
          : "border-white/10 bg-white/5 text-white/40"
      } ${className}`}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          title={enabled ? "Click to see exactly what is sent with your prompt" : "Screen context is off"}
          aria-expanded={expanded}
        >
          <span aria-hidden className="shrink-0 opacity-70">
            ▣
          </span>
          <span className="truncate">
            {enabled ? (
              <>
                <span className="opacity-70">context: </span>
                {summary}
              </>
            ) : (
              <span className="line-through opacity-70">context: {summary}</span>
            )}
          </span>
          <span aria-hidden className="shrink-0 opacity-50">
            {expanded ? "▾" : "▸"}
          </span>
        </button>
        <button
          type="button"
          onClick={toggle}
          className="shrink-0 rounded border border-current/30 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider opacity-80 hover:opacity-100"
          title={
            enabled
              ? "Stop attaching the screen you're viewing, and delete what was already reported"
              : "Attach the screen you're viewing to your prompts"
          }
        >
          {enabled ? "on" : "off"}
        </button>
      </div>

      {expanded && (
        <div className="border-t border-current/15 pt-1">
          {enabled ? (
            <>
              <div className="mb-0.5 opacity-70">Sent with your prompt, so the agent starts on the right file:</div>
              <ul className="space-y-0.5 font-mono text-[10px] opacity-90">
                {detail.map((line) => (
                  <li key={line} className="break-words">
                    {line}
                  </li>
                ))}
              </ul>
              <div className="mt-1 opacity-60">
                Labels and route only — never what you type into a field. Stays on your machine; never synced.
              </div>
            </>
          ) : (
            <div className="opacity-70">
              Off. Your prompts are sent exactly as typed, and the agent is not holding this screen.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
