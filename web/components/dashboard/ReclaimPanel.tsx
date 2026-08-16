"use client";

// ReclaimPanel.tsx — the space-freeing route a CapabilityGap offers when disk
// is the blocker, or nearly is.
//
// WHY IT EXISTS. "Flutter needs ~2 GB; /opt has 340 MB free" is a true refusal
// and, on its own, a dead end with a sentence — the exact thing CapabilityGap
// was built to abolish. The agent already ships a reclaim engine
// (desktop/agent/storage_reclaim.go) that knows which caches on THIS box are
// regenerable and what they cost to rebuild. This panel is the route to it.
//
// THE TWO HARD RULES, and where each is enforced:
//
//  1. SHOW BEFORE DELETE. The user sees every path, its size, and what
//     regenerating it costs, and ticks the ones they approve. Nothing is
//     pre-selected — a "clean up" that silently eats something wanted is a far
//     worse bug than a full disk. The gap's `confirm` block names the preview
//     route; this component cannot act without fetching it first, and the agent
//     refuses an apply that arrives without {"confirm":true} regardless of what
//     any client does.
//  2. ONLY PROVABLY-REGENERABLE PATHS. This component never picks targets; it
//     renders the ones the agent proposed. reclaimPathAllowed() on the agent
//     refuses the filesystem root, $HOME itself, anything outside $HOME, and any
//     directory containing a .git. The allowlist is server-side because a
//     client-side allowlist is a suggestion.

import { useCallback, useState } from "react";
import { agentClient } from "@/lib/agent-client";
import { gapConfirmPreview, type CapabilityGap, type GapFix } from "@/lib/capabilityGap";

type ReclaimTarget = {
  id: string;
  label: string;
  path?: string;
  project?: string;
  sizeBytes: number;
  rebuild: string;
};

type ReclaimGroup = { project: string; sizeBytes: number; targets: ReclaimTarget[] };

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function ReclaimPanel({ gap, onFreed }: { gap: CapabilityGap; onFreed?: () => void }) {
  const fix: GapFix | null | undefined = gap.reclaim;
  const preview = gapConfirmPreview(fix);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<ReclaimGroup[] | null>(null);
  const [partial, setPartial] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [freed, setFreed] = useState<string | null>(null);

  const loadPlan = useCallback(async () => {
    if (!preview) return;
    setLoading(true);
    setError(null);
    try {
      const res = await agentClient.agentFetch(preview.path, { method: preview.method || "GET" });
      if (!res.ok) throw new Error(`${preview.path} answered ${res.status}`);
      const body = await res.json();
      const scan = body?.scan ?? body;
      setGroups(Array.isArray(scan?.groups) ? scan.groups : []);
      setPartial(Boolean(scan?.partial));
    } catch (e) {
      // Naming the route that failed, not "something went wrong" — a vague
      // error here costs the user the only lever they had.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [preview]);

  const apply = useCallback(async () => {
    if (!fix) return;
    const ids = Object.keys(selected).filter((id) => selected[id]);
    if (ids.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const res = await agentClient.agentFetch(fix.path, {
        method: fix.method || "POST",
        headers: { "Content-Type": "application/json" },
        // The confirm field is named by the agent, not hardcoded here — one
        // more place a rename would silently turn deletes into no-ops.
        body: JSON.stringify({ ids, [preview?.field || "confirm"]: true }),
      });
      if (!res.ok) throw new Error(`${fix.path} answered ${res.status}`);
      const body = await res.json();
      setFreed(body?.result?.freed || body?.freed || "space");
      setSelected({});
      await loadPlan();
      onFreed?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [fix, selected, preview, loadPlan, onFreed]);

  if (!fix || !preview) return null;

  const selectedBytes = (groups ?? [])
    .flatMap((g) => g.targets ?? [])
    .filter((t) => selected[t.id])
    .reduce((sum, t) => sum + (t.sizeBytes || 0), 0);

  return (
    <div className="mt-2 rounded-md border border-amber-600/40 bg-amber-500/5 p-2">
      <button
        type="button"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next && !groups) void loadPlan();
        }}
        className="text-[11px] font-semibold text-amber-800 dark:text-amber-100"
      >
        {open ? "▾ " : "▸ "}
        {fix.label}
      </button>
      {fix.est ? <div className="mt-0.5 text-[10px] text-amber-700/80 dark:text-amber-200/60">{fix.est}</div> : null}

      {open ? (
        <div className="mt-2 space-y-2">
          <div className="text-[10px] leading-relaxed text-amber-800/90 dark:text-amber-100/80">{preview.prompt}</div>
          {loading ? <div className="text-[10px] text-amber-700 dark:text-amber-200/70">Scanning… this can take up to 45s on a large disk.</div> : null}
          {error ? <div className="text-[10px] text-rose-600 dark:text-rose-300">{error}</div> : null}
          {freed ? <div className="text-[10px] text-emerald-700 dark:text-emerald-300">Freed {freed}.</div> : null}
          {partial ? (
            <div className="text-[10px] text-amber-700/80 dark:text-amber-200/60">
              The scan hit its time limit — these numbers are a floor, not a total.
            </div>
          ) : null}

          {(groups ?? []).map((group) => (
            <div key={group.project || "system"}>
              <div className="text-[10px] font-semibold text-amber-800 dark:text-amber-100">
                {group.project || "Shared caches"} — {humanBytes(group.sizeBytes)}
              </div>
              {(group.targets ?? []).map((t) => (
                <label key={t.id} className="mt-1 flex items-start gap-2 text-[10px] text-amber-800/90 dark:text-amber-100/80">
                  <input
                    type="checkbox"
                    checked={Boolean(selected[t.id])}
                    onChange={(e) => setSelected((prev) => ({ ...prev, [t.id]: e.target.checked }))}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-semibold">{t.label}</span> — {humanBytes(t.sizeBytes)}
                    {t.path ? <span className="block font-mono opacity-70">{t.path}</span> : null}
                    {/* What regenerating it costs is the whole basis of an
                        informed approval. Never hide it behind a tooltip. */}
                    {t.rebuild ? <span className="block opacity-70">{t.rebuild}</span> : null}
                  </span>
                </label>
              ))}
            </div>
          ))}

          {groups && groups.length === 0 && !loading ? (
            <div className="text-[10px] text-amber-700/80 dark:text-amber-200/60">
              Nothing regenerable to reclaim here — this disk is full of things Yaver cannot prove are safe to
              delete. Free space by hand, or move this project to a machine with room.
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => void apply()}
            disabled={loading || selectedBytes === 0}
            className="rounded-md bg-rose-600 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
          >
            {selectedBytes > 0 ? `Delete selected — ${humanBytes(selectedBytes)}` : "Select what to delete"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
