"use client";

// StreamHealthNotice — ONE rendering of "the live output stream dropped".
//
// The failure it makes visible: a task-output SSE stream cut mid-render (relay
// bounce, box drop, tunnel break) used to end in silence, so the transcript
// simply stopped growing and the user could not tell a finished task from a
// severed tunnel. `reattaching` narrates the wait; `lost` hands over the
// button. The sentence itself comes from lib/taskStreamRecovery.ts, which is
// parity-tested against the mobile twin — this component never writes copy of
// its own, so the two surfaces cannot drift by rewording.
//
// Deliberately one small component rather than a block copied into each panel:
// five hand-rolled banners for one policy is the shape the audit already
// counts as a defect (three drifting relay-auth matchers, two drifting relay
// hint tables).

import type { TaskStreamHealth } from "@/lib/taskStreamWithRecovery";

export function StreamHealthNotice({
  health,
  className = "",
}: {
  health: TaskStreamHealth;
  className?: string;
}) {
  if (!health) return null;
  const lost = health.kind === "lost";
  return (
    <div
      role="status"
      className={`rounded-xl border px-3 py-2 text-[12px] leading-5 ${
        lost
          ? "border-rose-500/25 bg-rose-500/10 text-rose-200"
          : "border-amber-500/25 bg-amber-500/10 text-amber-200"
      } ${className}`}
    >
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] opacity-80">
        {lost ? "Live output lost" : "Live output interrupted"}
      </div>
      <div className="break-words">{health.message}</div>
      {lost && health.reattach ? (
        <button
          type="button"
          onClick={health.reattach}
          className="mt-2 rounded-lg border border-rose-400/40 px-3 py-1 text-[12px] font-semibold text-rose-100 hover:bg-rose-500/15"
        >
          Reattach
        </button>
      ) : null}
    </div>
  );
}
