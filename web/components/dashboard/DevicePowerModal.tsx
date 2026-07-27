"use client";

/**
 * DevicePowerModal — cloud-console power control for a Yaver machine.
 *
 * GCP and AWS can put a Reset button on every instance because the console owns
 * the hypervisor; the button is always honourable. Yaver does not own the
 * machine — it is a user-space agent on someone else's box — so this panel
 * never renders a power button from a guess. It ASKS the machine
 * (`GET /infra/power`, a read-only dry run) and renders the answer, including
 * the cases where the honest answer is "not from in here":
 *
 *   - inside a container there is no host to power-cycle, and a reboot command
 *     would at best stop the container;
 *   - a WSL distro restart is not a Windows reboot;
 *   - an agent running as an ordinary user cannot reboot at all — and that one
 *     IS fixable, so it gets the sudo-grant flow instead of a dead button.
 *
 * Two rules the UI enforces on top of the report:
 *
 *   1. A destructive action needs a TYPED confirmation, never a stray tap. The
 *      dialog states what dies before it accepts the word.
 *   2. After a reboot the machine goes silent, and silence is indistinguishable
 *      from a crash unless we narrate it. `powerProgress.ts` owns those
 *      sentences and — critically — refuses to say "recovered" until it has
 *      watched the box actually disappear first.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentClient, PowerAction, PowerReport } from "@/lib/agent-client";
import { rebootProgressFor, humanizeRebootSeconds, type RebootProgress } from "@/lib/powerProgress";

/** The word the user types to arm a machine reboot. Short enough to type,
 *  specific enough that it cannot be muscle memory from another dialog. */
const REBOOT_CONFIRM_WORD = "reboot";
const RESTART_CONFIRM_WORD = "restart";

function confirmWordFor(id: PowerAction["id"]): string {
  return id === "host_reboot" ? REBOOT_CONFIRM_WORD : RESTART_CONFIRM_WORD;
}

export function DevicePowerModal({
  deviceId,
  deviceName,
  agentClient,
  onClose,
}: {
  deviceId: string;
  deviceName: string;
  agentClient: AgentClient;
  onClose: () => void;
}) {
  const [report, setReport] = useState<PowerReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PowerAction | null>(null);
  const [typed, setTyped] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [progress, setProgress] = useState<RebootProgress | null>(null);

  // Load the capability report. This is the only thing that decides what the
  // panel offers — nothing here re-derives availability from the device row.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await agentClient.infraPowerReport(deviceId);
        if (!cancelled) setReport(r);
      } catch (e: any) {
        if (!cancelled) setLoadError(e?.message || "could not read the power report");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentClient, deviceId]);

  // ── Recovery watch ────────────────────────────────────────────────────────
  // Poll the machine after a reboot and narrate every second of it. `sawDown`
  // is the guard: a box keeps answering for a while after accepting a reboot,
  // so we may not call it recovered until we have seen it go away.
  const watchRef = useRef<{ startedAt: number; eta: number; sawDown: boolean } | null>(null);
  useEffect(() => {
    if (!watchRef.current) return;
    let stopped = false;
    const tick = async () => {
      const w = watchRef.current;
      if (!w || stopped) return;
      let reachable = false;
      try {
        // Any answer at all counts as reachable. We deliberately use the
        // read-only report rather than a heavier call.
        await agentClient.infraPowerReport(deviceId);
        reachable = true;
      } catch {
        reachable = false;
      }
      if (!reachable) w.sawDown = true;
      const next = rebootProgressFor({
        elapsedSeconds: Math.round((Date.now() - w.startedAt) / 1000),
        etaSeconds: w.eta,
        reachable,
        sawUnreachable: w.sawDown,
        machineName: deviceName,
      });
      if (stopped) return;
      setProgress(next);
      if (!next.done) setTimeout(tick, 4000);
    };
    const t = setTimeout(tick, 3000);
    return () => {
      stopped = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress === null ? "idle" : "watching", agentClient, deviceId, deviceName]);

  const run = useCallback(
    async (action: PowerAction) => {
      setSubmitting(true);
      setActionError(null);
      try {
        const res = await agentClient.infraPower(action.id, deviceId);
        if (action.id === "host_reboot" || action.id === "agent_restart") {
          const eta = Number(res?.etaSeconds) || action.etaSeconds || 60;
          watchRef.current = { startedAt: Date.now(), eta, sawDown: false };
          setProgress(
            rebootProgressFor({
              elapsedSeconds: 0,
              etaSeconds: eta,
              reachable: true,
              sawUnreachable: false,
              machineName: deviceName,
            }),
          );
        } else {
          onClose();
        }
      } catch (e: any) {
        setActionError(e?.message || "the action failed");
      } finally {
        setSubmitting(false);
      }
    },
    [agentClient, deviceId, deviceName, onClose],
  );

  const armed = selected ? typed.trim().toLowerCase() === confirmWordFor(selected.id) : false;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-surface-800 dark:bg-surface-900">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-surface-800">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-surface-50">Power</h2>
            <p className="text-[11px] text-slate-500 dark:text-surface-400">{deviceName}</p>
          </div>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:text-surface-400 dark:hover:bg-surface-800"
          >
            Close
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-4 py-3">
          {/* Recovery narration takes over the panel once an action is in
              flight — the machine is gone and this is the only thing the user
              needs to see. */}
          {progress ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-900 dark:text-surface-50">{progress.headline}</p>
              <p className="text-xs leading-relaxed text-slate-600 dark:text-surface-300">{progress.detail}</p>
              {progress.phase === "down" || progress.phase === "issued" ? (
                <div className="h-1 w-full overflow-hidden rounded bg-slate-200 dark:bg-surface-800">
                  <div
                    className="h-full bg-sky-500 transition-all duration-1000"
                    style={{
                      width: `${Math.min(
                        100,
                        Math.round(
                          (progress.elapsedSeconds /
                            Math.max(1, progress.elapsedSeconds + progress.remainingSeconds)) *
                            100,
                        ),
                      )}%`,
                    }}
                  />
                </div>
              ) : null}
              {progress.remedy ? (
                <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
                  {progress.remedy}
                </p>
              ) : null}
              {progress.done ? (
                <button
                  onClick={onClose}
                  className="mt-1 rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-surface-50 dark:text-surface-900"
                >
                  Done
                </button>
              ) : null}
            </div>
          ) : loadError ? (
            <p className="text-xs text-rose-600 dark:text-rose-400">
              Could not read what this machine can do: {loadError}
            </p>
          ) : !report ? (
            <p className="text-xs text-slate-500 dark:text-surface-400">Asking the machine what it can do…</p>
          ) : (
            <div className="space-y-3">
              {/* Say what kind of host this is BEFORE the actions, so the
                  refusals below read as facts about the machine rather than as
                  Yaver being broken. */}
              <HostLine report={report} />
              {report.actions.map((a) => (
                <ActionRow
                  key={a.id}
                  action={a}
                  selected={selected?.id === a.id}
                  typed={typed}
                  armed={armed}
                  submitting={submitting}
                  error={selected?.id === a.id ? actionError : null}
                  onSelect={() => {
                    setSelected(selected?.id === a.id ? null : a);
                    setTyped("");
                    setActionError(null);
                  }}
                  onType={setTyped}
                  onConfirm={() => run(a)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function HostLine({ report }: { report: PowerReport }) {
  const f = report.facts;
  const bits: string[] = [f.goos];
  if (f.container) bits.push(`${f.container} container`);
  if (f.wslVersion) bits.push(`WSL${f.wslVersion}`);
  if (f.isRoot) bits.push("root");
  else if (f.agentUser) bits.push(`agent runs as ${f.agentUser}`);
  if (f.serviceManager) bits.push(f.serviceManager);
  return (
    <p className="text-[11px] text-slate-500 dark:text-surface-400">{bits.filter(Boolean).join(" · ")}</p>
  );
}

function ActionRow({
  action,
  selected,
  typed,
  armed,
  submitting,
  error,
  onSelect,
  onType,
  onConfirm,
}: {
  action: PowerAction;
  selected: boolean;
  typed: string;
  armed: boolean;
  submitting: boolean;
  error: string | null;
  onSelect: () => void;
  onType: (v: string) => void;
  onConfirm: () => void;
}) {
  const word = confirmWordFor(action.id);
  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-surface-800">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-slate-900 dark:text-surface-50">{action.label}</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-600 dark:text-surface-300">{action.means}</p>
        </div>
        <button
          disabled={!action.available}
          onClick={onSelect}
          className={
            action.available
              ? "shrink-0 rounded border border-rose-300 px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950/40"
              : "shrink-0 cursor-not-allowed rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-400 dark:border-surface-800 dark:text-surface-600"
          }
        >
          {action.available ? (selected ? "Cancel" : "Run…") : "Unavailable"}
        </button>
      </div>

      {/* An unavailable action states its cause and its remedy. This is the
          whole point — a bare disabled button is what sent users to a spinner. */}
      {!action.available ? (
        <div className="mt-2 space-y-1 border-t border-slate-100 pt-2 dark:border-surface-800">
          {action.reason ? (
            <p className="text-[11px] leading-relaxed text-slate-500 dark:text-surface-400">{action.reason}</p>
          ) : null}
          {action.remedy ? (
            <p className="whitespace-pre-wrap rounded bg-slate-50 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-slate-700 dark:bg-surface-950 dark:text-surface-300">
              {action.remedy}
            </p>
          ) : null}
          {action.alternative ? (
            <p className="text-[11px] text-slate-500 dark:text-surface-400">
              You can still use <span className="font-medium">{action.alternative.replace(/_/g, " ")}</span> below.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Typed confirmation. States the cost, then asks for the word. */}
      {selected && action.available ? (
        <div className="mt-2 space-y-2 border-t border-slate-100 pt-2 dark:border-surface-800">
          {action.loses?.length ? (
            <div>
              <p className="text-[11px] font-medium text-slate-700 dark:text-surface-200">This kills:</p>
              <ul className="mt-0.5 list-disc pl-4 text-[11px] leading-relaxed text-slate-600 dark:text-surface-300">
                {action.loses.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {action.command ? (
            <p className="font-mono text-[10px] text-slate-500 dark:text-surface-400">runs: {action.command}</p>
          ) : null}
          {action.etaSeconds ? (
            <p className="text-[11px] text-slate-500 dark:text-surface-400">
              Expect it back in about {humanizeRebootSeconds(action.etaSeconds)}.
            </p>
          ) : null}
          <label className="block text-[11px] text-slate-600 dark:text-surface-300">
            Type <span className="font-mono font-semibold">{word}</span> to confirm:
            <input
              autoFocus
              value={typed}
              onChange={(e) => onType(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs dark:border-surface-700 dark:bg-surface-950 dark:text-surface-100"
              placeholder={word}
            />
          </label>
          {error ? <p className="text-[11px] text-rose-600 dark:text-rose-400">{error}</p> : null}
          <button
            disabled={!armed || submitting}
            onClick={onConfirm}
            className={
              armed && !submitting
                ? "w-full rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700"
                : "w-full cursor-not-allowed rounded bg-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-400 dark:bg-surface-800 dark:text-surface-600"
            }
          >
            {submitting ? "Sending…" : action.label}
          </button>
        </div>
      ) : null}
    </div>
  );
}
