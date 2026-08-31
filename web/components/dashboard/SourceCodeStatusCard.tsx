"use client";

import { useEffect, useMemo, useState } from "react";
import { agentClient, type GitStatusRow } from "@/lib/agent-client";
import type { Device } from "@/lib/use-devices";

type Props = {
  devices: Device[];
};

type RepoRow = {
  name: string;
  path: string;
  branch?: string;
  remote?: string;
  lastCommit?: string;
  dirty?: boolean;
};

type SourceStatusRow = {
  repo: RepoRow | null;
  git: GitStatusRow | null;
  error?: string;
};

function repoMatchScore(repo: RepoRow): number {
  let score = 0;
  const path = repo.path.toLowerCase();
  const name = repo.name.toLowerCase();
  const remote = (repo.remote || "").toLowerCase();
  if (name === "yaver.io") score += 8;
  if (path.endsWith("/yaver.io")) score += 8;
  if (remote.includes("yaver.io")) score += 6;
  return score;
}

function pickYaverRepo(repos: RepoRow[]): RepoRow | null {
  return [...repos]
    .sort((a, b) => repoMatchScore(b) - repoMatchScore(a))
    .find((repo) => repoMatchScore(repo) > 0) || null;
}

function formatCommit(raw?: string): string {
  const text = (raw || "").trim();
  if (!text) return "unknown";
  const [hash, ...rest] = text.split(" ");
  return `${hash.slice(0, 8)}${rest.length ? ` ${rest.join(" ")}` : ""}`;
}

function providerLabel(remote?: string): string {
  const value = (remote || "").toLowerCase();
  if (value.includes("github")) return "GitHub";
  if (value.includes("gitlab")) return "GitLab";
  return "Git remote";
}

export default function SourceCodeStatusCard({ devices }: Props) {
  const peers = useMemo(
    () =>
      devices
        .filter((device) => device.online && device.deviceClass !== "edge-mobile")
        .map((device) => ({ id: device.id, name: device.name || device.id })),
    [devices],
  );
  const targetOptions = useMemo(() => [{ id: "__local__", name: "This machine" }, ...peers], [peers]);
  const [targetIds, setTargetIds] = useState<string[]>(["__local__"]);
  const [rowsByTarget, setRowsByTarget] = useState<Record<string, SourceStatusRow>>({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!agentClient.isConnected) return;
      const next: Record<string, SourceStatusRow> = {};
      for (const targetId of targetIds) {
        const target = targetId === "__local__" ? undefined : targetId;
        try {
          const repos = await agentClient.listRepos(target);
          const repo = pickYaverRepo(repos);
          if (!repo) {
            next[targetId] = { repo: null, git: null, error: "No yaver.io checkout found." };
            continue;
          }
          const git = await agentClient.gitStatus(repo.path, target);
          next[targetId] = { repo, git };
        } catch (error) {
          next[targetId] = {
            repo: null,
            git: null,
            error: error instanceof Error ? error.message : "Source status failed.",
          };
        }
      }
      if (!cancelled) setRowsByTarget((current) => ({ ...current, ...next }));
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [targetIds]);

  return (
    <div className="card mb-6">
      <h3 className="mb-3 text-sm font-medium uppercase tracking-wider text-surface-400">
        Source Code Status
      </h3>
      <p className="mb-4 text-xs leading-5 text-surface-500">
        Dogfood visibility for the live <code>yaver.io</code> checkout: branch, commit, dirty state, and origin drift across this machine and selected peers.
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
                  ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                  : "border-surface-700 text-surface-400 hover:border-surface-600 hover:text-surface-200"
              }`}
            >
              {option.name}
            </button>
          );
        })}
      </div>

      {!agentClient.isConnected ? (
        <p className="text-xs text-surface-500">Connect a device first to inspect source status.</p>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        {targetIds.map((targetId) => {
          const label = targetOptions.find((option) => option.id === targetId)?.name || targetId;
          const row = rowsByTarget[targetId];
          return (
            <div key={targetId} className="rounded-lg border border-surface-800 bg-surface-900/50 p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-surface-500">{label}</div>
              {!row ? (
                <p className="text-xs text-surface-500">Loading source status…</p>
              ) : row.error ? (
                <p className="text-xs text-rose-700 dark:text-rose-300">{row.error}</p>
              ) : row.repo && row.git ? (
                <div className="space-y-1.5 text-xs text-surface-300">
                  <div><span className="text-surface-500">Path:</span> <code>{row.repo.path}</code></div>
                  <div><span className="text-surface-500">Branch:</span> <code>{row.git.branch || row.repo.branch || "unknown"}</code></div>
                  <div><span className="text-surface-500">Commit:</span> <code>{formatCommit(row.repo.lastCommit)}</code></div>
                  <div><span className="text-surface-500">State:</span> {row.git.clean ? "clean" : "dirty"}</div>
                  <div><span className="text-surface-500">Sync:</span> {row.git.ahead || 0} ahead · {row.git.behind || 0} behind</div>
                  <div><span className="text-surface-500">{providerLabel(row.repo.remote)}:</span> <code>{row.repo.remote || "none"}</code></div>
                </div>
              ) : (
                <p className="text-xs text-surface-500">No source status loaded.</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
