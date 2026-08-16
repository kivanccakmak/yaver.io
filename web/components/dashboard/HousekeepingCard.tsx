"use client";

/**
 * HousekeepingCard — the custodian, made visible.
 *
 * The agent grew a self-healing layer today (desktop/agent/custodian.go): wardens
 * that sweep for "the inventory says yes, the operation says no" drift, a lookup
 * table of failures we have already diagnosed once, and autonomous runner
 * escalation for the rest. All of it worked and none of it was visible anywhere —
 * the only place it spoke was a launchd stderr log on a Mac mini.
 *
 * That is not a cosmetic gap. When a machine says "every simulator is already
 * claimed", the user cannot tell whether the box is busy or lying, and a janitor
 * nobody can see is indistinguishable from no janitor. This card is the other
 * half of that feature.
 *
 * Three honesty rules it inherits:
 *   • "nothing was wrong" is an ANSWER — never render it as a blank panel.
 *   • a warden that has NEVER swept must say so, not appear healthy.
 *   • `spared` is worth showing: "I looked and chose not to touch it" is
 *     information, and hiding it makes the next debugger re-derive everything.
 */

import { useCallback, useEffect, useState } from "react";
import { agentClient } from "@/lib/agent-client";

type Outcome = "fixed" | "spared" | "needs-human" | "needs-runner";

interface Finding {
  warden: string;
  subject: string;
  problem: string;
  action: string;
  outcome: Outcome;
  remedy?: string;
  at: string;
}

interface WardenState {
  name: string;
  everySec: number;
  lastSwept?: string;
  neverRun: boolean;
}

const OUTCOME_STYLE: Record<Outcome, { dot: string; text: string; label: string }> = {
  fixed: { dot: "bg-emerald-400", text: "text-emerald-400", label: "fixed" },
  spared: { dot: "bg-surface-500", text: "text-surface-400", label: "left alone" },
  "needs-human": { dot: "bg-amber-400", text: "text-amber-400", label: "needs you" },
  "needs-runner": { dot: "bg-indigo-400", text: "text-indigo-300", label: "auto-repairing" },
};

function ago(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export default function HousekeepingCard({ enabled }: { enabled: boolean }) {
  const [wardens, setWardens] = useState<WardenState[]>([]);
  const [recent, setRecent] = useState<Finding[]>([]);
  const [sweeping, setSweeping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sweepSummary, setSweepSummary] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await agentClient.getCustodianStatus();
      setWardens(r.wardens);
      setRecent(r.recent as Finding[]);
      setSweeping(r.sweeping);
      setLoadError(null);
    } catch (err: any) {
      // Distinguish "could not ask" from "nothing to report" — collapsing those
      // two is the exact bug this whole layer exists to remove.
      setLoadError(err?.message || "could not reach the agent's housekeeping feed");
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const iv = setInterval(() => void load(), 30_000);
    return () => clearInterval(iv);
  }, [enabled, load]);

  const sweepNow = async () => {
    setBusy(true);
    setSweepSummary(null);
    try {
      const r = await agentClient.sweepCustodian();
      setSweepSummary(r.summary || `Checked ${r.swept} areas.`);
      await load();
    } catch (err: any) {
      setSweepSummary(`Sweep failed: ${err?.message || "unknown"}`);
    } finally {
      setBusy(false);
    }
  };

  if (!enabled) return null;

  return (
    <div className="rounded-xl border border-surface-800 bg-surface-900/50 p-4">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs uppercase tracking-wide font-semibold text-surface-400">Housekeeping</span>
        {sweeping ? (
          <span className="text-[11px] text-emerald-400">watching {wardens.length} area{wardens.length === 1 ? "" : "s"}</span>
        ) : (
          <span className="text-[11px] text-amber-400">not sweeping</span>
        )}
        <div className="flex-1" />
        <button
          onClick={sweepNow}
          disabled={busy}
          className="px-2.5 py-1 text-[11px] rounded-lg bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-500/30 disabled:opacity-50"
          title="Run every warden now and tell me what it found"
        >
          {busy ? "Checking…" : "Check now"}
        </button>
      </div>

      {/* Wardens that have never run are the one state a status panel must not
          render as healthy. */}
      {wardens.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {wardens.map((w) => (
            <span
              key={w.name}
              title={w.neverRun ? `${w.name} has not swept yet (every ${w.everySec}s)` : `last swept ${ago(w.lastSwept || "")}`}
              className={`px-2 py-0.5 rounded-full text-[11px] border ${
                w.neverRun
                  ? "border-amber-500/40 text-amber-400"
                  : "border-surface-700 text-surface-400"
              }`}
            >
              {w.name}
              {w.neverRun ? " · not yet" : ` · ${ago(w.lastSwept || "")}`}
            </span>
          ))}
        </div>
      )}

      {sweepSummary && <div className="mt-2 text-xs text-surface-300">{sweepSummary}</div>}

      {loadError && <div className="mt-2 text-xs text-amber-400">{loadError}</div>}

      {!loadError && recent.length === 0 && (
        // An empty feed is an answer, not a blank panel.
        <div className="mt-2 text-xs text-surface-500">
          Nothing needed fixing. Orphaned dev servers, abandoned streaming sessions and
          stuck ports are checked automatically.
        </div>
      )}

      {recent.length > 0 && (
        <div className="mt-3 space-y-2">
          {recent.slice(0, 6).map((f, i) => {
            const style = OUTCOME_STYLE[f.outcome] || OUTCOME_STYLE.spared;
            return (
              <div key={`${f.at}-${i}`} className="flex gap-2 text-xs">
                <div className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${style.dot}`} />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={`font-semibold ${style.text}`}>{style.label}</span>
                    <span className="text-surface-500 font-mono truncate">{f.subject}</span>
                    <span className="text-surface-600">{ago(f.at)}</span>
                  </div>
                  <div className="text-surface-300">{f.problem}</div>
                  <div className="text-surface-500">{f.action}</div>
                  {f.remedy && <div className="text-amber-400">→ {f.remedy}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
