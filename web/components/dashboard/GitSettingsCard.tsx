"use client";

import { useEffect, useMemo, useState } from "react";
import { agentClient, type MachineOnboardingProviderStatus } from "@/lib/agent-client";
import type { Device } from "@/lib/use-devices";

type Props = {
  devices: Device[];
};

function SecretField({
  label,
  value,
  onChange,
  placeholder,
  secret = true,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  secret?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-surface-400">{label}</span>
      <input
        type={secret ? "password" : "text"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-lg border border-surface-700 bg-surface-900 px-3 py-2 text-sm text-surface-200 placeholder-surface-600 outline-none focus:border-surface-500"
      />
    </label>
  );
}

function ProviderRow({ row }: { row: MachineOnboardingProviderStatus }) {
  const ready = row.ready || row.cloneReady || row.ciReady;
  return (
    <div className="rounded-lg border border-surface-800 bg-surface-950/70 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-surface-200">{row.name || row.id}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${
            ready
              ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "border border-surface-700 text-surface-500"
          }`}
        >
          {ready ? "ready" : "not wired"}
        </span>
      </div>
      <div className="mt-1 text-xs text-surface-500">
        {row.username || row.host || row.detail || row.warning || "No credential status reported yet."}
      </div>
    </div>
  );
}

export default function GitSettingsCard({ devices }: Props) {
  const peers = useMemo(
    () =>
      devices
        .filter((device) => device.online && !device.isGuest && device.deviceClass !== "edge-mobile")
        .map((device) => ({ id: device.id, name: device.name || device.hostName || device.id })),
    [devices],
  );
  const targetOptions = useMemo(() => [{ id: "__local__", name: "This machine" }, ...peers], [peers]);

  const [targetIds, setTargetIds] = useState<string[]>(["__local__"]);
  const [rowsByTarget, setRowsByTarget] = useState<Record<string, MachineOnboardingProviderStatus[]>>({});
  const [githubToken, setGithubToken] = useState("");
  const [gitlabToken, setGitlabToken] = useState("");
  const [gitlabHost, setGitlabHost] = useState("gitlab.com");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<"github" | "gitlab" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!agentClient.isConnected) return;
      const next: Record<string, MachineOnboardingProviderStatus[]> = {};
      for (const targetId of targetIds) {
        try {
          next[targetId] = await agentClient.machineOnboardingStatus(
            targetId === "__local__" ? undefined : targetId,
          );
        } catch {
          next[targetId] = [];
        }
      }
      if (!cancelled) setRowsByTarget((current) => ({ ...current, ...next }));
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [targetIds]);

  async function apply() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    const summaries: string[] = [];
    const failures: string[] = [];
    const nextRows: Record<string, MachineOnboardingProviderStatus[]> = {};
    for (const targetId of targetIds) {
      const label = targetOptions.find((option) => option.id === targetId)?.name || targetId;
      const result = await agentClient.machineOnboardingApply(
        {
          githubToken,
          gitlabToken,
          gitlabHost,
          applyClone: true,
          applyCiToken: true,
          notes: "Saved from Yaver web settings.",
        },
        targetId === "__local__" ? undefined : targetId,
      );
      if (!result.ok) {
        failures.push(`${label}: ${result.error || "failed"}`);
      } else {
        nextRows[targetId] = result.providers;
        summaries.push(`${label}: ${result.applied.length ? result.applied.join(", ") : "no changes"}`);
      }
    }
    setRowsByTarget((current) => ({ ...current, ...nextRows }));
    setGithubToken("");
    setGitlabToken("");
    setBusy(false);
    if (summaries.length) setMessage(summaries.join(" | "));
    if (failures.length) setError(failures.join(" | "));
  }

  async function remove(provider: "github" | "gitlab") {
    if (removing) return;
    setRemoving(provider);
    setMessage(null);
    setError(null);
    const summaries: string[] = [];
    const failures: string[] = [];
    const nextRows: Record<string, MachineOnboardingProviderStatus[]> = {};
    for (const targetId of targetIds) {
      const label = targetOptions.find((option) => option.id === targetId)?.name || targetId;
      const result = await agentClient.machineOnboardingRemove(
        {
          providers: [provider],
          gitlabHost: provider === "gitlab" ? gitlabHost : undefined,
          removeClone: true,
          removeCiToken: true,
        },
        targetId === "__local__" ? undefined : targetId,
      );
      if (!result.ok) {
        failures.push(`${label}: ${result.error || "failed"}`);
      } else {
        nextRows[targetId] = result.providers;
        summaries.push(`${label}: removed ${provider}`);
      }
    }
    setRowsByTarget((current) => ({ ...current, ...nextRows }));
    setRemoving(null);
    if (summaries.length) setMessage(summaries.join(" | "));
    if (failures.length) setError(failures.join(" | "));
  }

  return (
    <div className="card mb-6">
      <h3 className="mb-3 text-sm font-medium uppercase tracking-wider text-surface-400">
        Git Wiring
      </h3>
      <p className="mb-4 text-xs leading-5 text-surface-500">
        Link GitHub or GitLab above for account sign-in. Add machine tokens here only for boxes that need to clone, pull, push, run CI, or deploy private repos.
      </p>

      <div className="mb-4 flex flex-wrap gap-2">
        {targetOptions.map((option) => {
          const selected = targetIds.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              onClick={() =>
                setTargetIds((current) =>
                  current.includes(option.id)
                    ? current.filter((id) => id !== option.id)
                    : [...current, option.id],
                )
              }
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                selected
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "border-surface-700 text-surface-400 hover:border-surface-600 hover:text-surface-200"
              }`}
            >
              {option.name}
            </button>
          );
        })}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <SecretField label="GitHub token" value={githubToken} onChange={setGithubToken} placeholder="ghp_..." />
        <SecretField label="GitLab token" value={gitlabToken} onChange={setGitlabToken} placeholder="glpat-..." />
        <SecretField label="GitLab host" value={gitlabHost} onChange={setGitlabHost} placeholder="gitlab.com" secret={false} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void apply()}
          disabled={busy || targetIds.length === 0 || (!githubToken.trim() && !gitlabToken.trim())}
          className="rounded-lg border border-surface-700 px-4 py-2 text-sm font-medium text-surface-200 hover:bg-surface-800/50 disabled:opacity-40"
        >
          {busy ? "Applying..." : "Apply Git Tokens"}
        </button>
        <button
          type="button"
          onClick={() => void remove("github")}
          disabled={!!removing || targetIds.length === 0}
          className="rounded-lg border border-rose-500/40 px-4 py-2 text-sm font-medium text-rose-700 dark:text-rose-300 disabled:opacity-40"
        >
          {removing === "github" ? "Removing..." : "Remove GitHub"}
        </button>
        <button
          type="button"
          onClick={() => void remove("gitlab")}
          disabled={!!removing || targetIds.length === 0}
          className="rounded-lg border border-rose-500/40 px-4 py-2 text-sm font-medium text-rose-700 dark:text-rose-300 disabled:opacity-40"
        >
          {removing === "gitlab" ? "Removing..." : "Remove GitLab"}
        </button>
      </div>

      {message ? <p className="mt-3 text-xs text-emerald-700 dark:text-emerald-300">{message}</p> : null}
      {error ? <p className="mt-3 text-xs text-rose-700 dark:text-rose-300">{error}</p> : null}
      {!agentClient.isConnected ? (
        <p className="mt-3 text-xs text-surface-500">Connect a device first to read or update machine Git wiring.</p>
      ) : null}

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {targetIds.map((targetId) => {
          const label = targetOptions.find((option) => option.id === targetId)?.name || targetId;
          const rows = rowsByTarget[targetId] || [];
          return (
            <div key={targetId} className="rounded-lg border border-surface-800 bg-surface-900/50 p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-surface-500">{label}</div>
              {rows.length ? (
                <div className="space-y-2">
                  {rows
                    .filter((row) => row.id === "github" || row.id === "gitlab")
                    .map((row) => <ProviderRow key={`${targetId}:${row.id}:${row.host || ""}`} row={row} />)}
                </div>
              ) : (
                <p className="text-xs text-surface-500">No Git status loaded.</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
