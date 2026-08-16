"use client";

/**
 * PlanUsageCard — the settings "Plan & usage" section (web only, by design:
 * the phone shows connection state, the dashboard is where account/plan
 * questions get answered — like the Claude Code / Codex web UIs).
 *
 * Data comes from the relay's /my/bandwidth via agentClient.fetchMyRelayUsage:
 * the caller's Convex-verified plan plus usage rows scoped to their OWN
 * devices. Owner accounts see "no limits" AND their real numbers — "am I
 * capped" and "how much am I moving" are different questions and the
 * 2026-07-27 incident (a poll bug silently burning 1.9GB) is exactly why the
 * second one stays visible for everyone.
 */

import { useEffect, useState } from "react";
import { agentClient } from "@/lib/agent-client";

type UsageRow = { deviceId: string; usedMb: number; limitMb: number; isPaid: boolean; unmetered?: boolean };
type Usage = { plan: string; isPaid: boolean; unmetered: boolean; devices: UsageRow[] };

const PLAN_LABEL: Record<string, string> = {
  "owner-dev": "Owner",
  "cloud-workspace": "Cloud Workspace",
  "relay-pro": "Relay Pro",
  free: "Free",
};

export function PlanUsageCard({ deviceNames }: { deviceNames?: Record<string, string> }) {
  const [usage, setUsage] = useState<Usage | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    agentClient
      .fetchMyRelayUsage()
      .then((data) => { if (!cancelled) setUsage(data); })
      .catch((err) => { if (!cancelled) { setUsage(null); setError(err instanceof Error ? err.message : String(err)); } });
    return () => { cancelled = true; };
  }, []);

  const planLabel = usage ? (PLAN_LABEL[usage.plan] || usage.plan || "Free") : null;
  const isOwner = usage?.plan === "owner-dev";

  return (
    <section className="mb-4 rounded-lg border border-surface-800 bg-surface-900/60 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-surface-200">Plan &amp; usage</h2>
        {usage ? (
          <span
            className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
              isOwner
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                : usage.isPaid
                  ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300"
                  : "border-surface-700 bg-surface-800/60 text-surface-300"
            }`}
          >
            {planLabel}
          </span>
        ) : null}
      </div>

      {usage === undefined ? (
        <p className="mt-2 text-[12px] text-surface-500">Loading usage…</p>
      ) : usage === null ? (
        <p className="mt-2 text-[12px] text-surface-500">
          {error
            ? `Couldn't load usage: ${error}`
            : "Connect to a device over the relay to see this account's plan and data usage."}
        </p>
      ) : (
        <>
          <p className="mt-1.5 text-[12px] text-surface-400">
            {isOwner
              ? "You are the owner — relay traffic is unmetered for your account, on every device and every lane. Usage is still recorded so a runaway loop stays visible:"
              : usage.isPaid
                ? "Paid plan — each device gets the raised daily relay allowance. Usage today:"
                : "Free plan — each device gets the free daily relay allowance. Same-LAN connections bypass the relay and don't count. Usage today:"}
          </p>
          <ul className="mt-2 space-y-1.5">
            {usage.devices.length === 0 ? (
              <li className="text-[12px] text-surface-500">No devices are connected through the relay right now.</li>
            ) : (
              usage.devices.map((d) => {
                const name = deviceNames?.[d.deviceId] || `${d.deviceId.slice(0, 8)}…`;
                const uncapped = d.unmetered || isOwner;
                const pct = uncapped || d.limitMb <= 0 ? 0 : Math.min(100, Math.round((d.usedMb / d.limitMb) * 100));
                return (
                  <li key={d.deviceId} className="flex items-center gap-3 text-[12px]">
                    <span className="min-w-0 flex-1 truncate text-surface-300">{name}</span>
                    <span className="tabular-nums text-surface-400">
                      {d.usedMb} MB{uncapped ? " · no limit" : ` of ${d.limitMb} MB`}
                    </span>
                    {!uncapped ? (
                      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-800">
                        <span
                          className={`block h-full rounded-full ${pct >= 90 ? "bg-rose-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500"}`}
                          style={{ width: `${pct}%` }}
                        />
                      </span>
                    ) : (
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">∞</span>
                    )}
                  </li>
                );
              })
            )}
          </ul>
        </>
      )}
    </section>
  );
}
