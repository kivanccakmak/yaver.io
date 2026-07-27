"use client";

/**
 * RawFailureBanner — the dashboard's last line of defence against a failure
 * the user can neither read nor act on.
 *
 * INCIDENT THIS EXISTS FOR (production yaver.io, 2026-07-27)
 * ---------------------------------------------------------
 * Vibing → Runtime → pick runner + model → "Save for machine" → `failed to
 * fetch`. Two independent defects stacked:
 *
 *   1. Convex answered the write with its uncaught-exception 500, which ships
 *      no `Access-Control-Allow-Origin`. The browser is not allowed to read
 *      such a response at all, so `fetch()` rejects with a bare TypeError.
 *      Fixed at source in backend/convex/http.ts (POST /settings now returns a
 *      CORS-carrying 401 "Session expired").
 *   2. The click handler was `onClick={() => void saveRunnerChoice()}` with no
 *      catch anywhere in the chain, so the rejection went UNHANDLED: the
 *      optimistic dropdown silently reverted and the page said nothing. A
 *      button that quietly undoes itself is indistinguishable from a button
 *      that does nothing.
 *
 * Defect 2 is not one call site — `void someAsync()` appears all over the
 * dashboard, and every future one regenerates the same silence. So the guard
 * is global: any rejection that would otherwise reach the user as a raw
 * network TypeError gets named here, with the route out. `describeRawFailure`
 * returns null for anything already self-describing (real HTTP statuses,
 * deliberate aborts), so this stays quiet unless the alternative is silence.
 *
 * Other views may also announce a failure explicitly via
 *   window.dispatchEvent(new CustomEvent("yaver:raw-failure",
 *     { detail: { reason, operation } }))
 * which is the seam a call site should use once it DOES catch its own error.
 */

import { useCallback, useEffect, useState } from "react";
import { describeRawFailure, type NamedFailure } from "@/lib/rawFailure";

export const RAW_FAILURE_EVENT = "yaver:raw-failure";

/** Announce a failure you already caught. Prefer this over rethrowing into the
 *  void — it renders the same named banner without an unhandled rejection. */
export function announceRawFailure(reason: unknown, operation?: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(RAW_FAILURE_EVENT, { detail: { reason, operation } }));
}

export default function RawFailureBanner({ onSignOut }: { onSignOut?: () => void }) {
  const [failure, setFailure] = useState<NamedFailure | null>(null);
  const [copied, setCopied] = useState(false);

  const show = useCallback((reason: unknown, operation?: string) => {
    const named = describeRawFailure(reason, {
      online: typeof navigator === "undefined" ? undefined : navigator.onLine,
      operation,
    });
    if (!named) return;
    setCopied(false);
    setFailure(named);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onRejection = (event: PromiseRejectionEvent) => {
      show(event.reason);
    };
    const onAnnounced = (event: Event) => {
      const detail = (event as CustomEvent).detail as { reason?: unknown; operation?: string } | undefined;
      show(detail?.reason, detail?.operation);
    };
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener(RAW_FAILURE_EVENT, onAnnounced);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener(RAW_FAILURE_EVENT, onAnnounced);
    };
  }, [show]);

  if (!failure) return null;

  const tone =
    failure.kind === "auth"
      ? "border-amber-500/40 bg-amber-500/10"
      : failure.kind === "offline"
        ? "border-sky-500/40 bg-sky-500/10"
        : "border-rose-500/40 bg-rose-500/10";

  return (
    <div
      role="alert"
      className={`pointer-events-auto fixed inset-x-3 bottom-3 z-50 mx-auto max-w-xl rounded-lg border px-4 py-3 shadow-lg backdrop-blur md:inset-x-auto md:right-4 ${tone}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-surface-100">{failure.title}</div>
          <p className="mt-1 text-xs leading-5 text-surface-300">{failure.detail}</p>
          <p className="mt-1.5 text-xs font-medium leading-5 text-surface-200">{failure.action}</p>
        </div>
        <button
          type="button"
          onClick={() => setFailure(null)}
          aria-label="Dismiss"
          className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-surface-400 hover:text-surface-100"
        >
          ✕
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {failure.needsSignIn && onSignOut ? (
          <button
            type="button"
            onClick={onSignOut}
            className="rounded-md border border-amber-500/40 bg-amber-500/15 px-2.5 py-1 text-[11px] font-semibold text-amber-200"
          >
            Sign in again
          </button>
        ) : null}
        {failure.retryable ? (
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md border border-surface-700 bg-surface-800 px-2.5 py-1 text-[11px] font-semibold text-surface-200"
          >
            Reload dashboard
          </button>
        ) : null}
        {failure.raw ? (
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(failure.raw).then(() => setCopied(true)).catch(() => {});
            }}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-surface-400 hover:text-surface-200"
            title={failure.raw}
          >
            {copied ? "Copied" : `Copy details (${failure.raw.slice(0, 28)})`}
          </button>
        ) : null}
      </div>
    </div>
  );
}
