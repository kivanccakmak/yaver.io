import React, { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { quicClient } from "../lib/quic";

type Palette = {
  textPrimary: string;
  textMuted: string;
  border: string;
  bg: string;
  bgCardElevated: string;
  success: string;
  accent: string;
  error: string;
};

type DeviceOption = {
  id: string;
  name?: string;
  os?: string;
  online?: boolean;
  deviceClass?: string;
};

type RepoRow = {
  name: string;
  path: string;
  branch?: string;
  remote?: string;
  lastCommit?: string;
  dirty?: boolean;
};

type GitRow = {
  branch: string;
  ahead: number;
  behind: number;
  clean: boolean;
  staged: unknown[];
  modified: unknown[];
  untracked: unknown[];
};

type SourceStatusRow = {
  repo: RepoRow | null;
  git: GitRow | null;
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

export default function SourceCodeStatusSection({
  c,
  devices,
  activeDeviceId,
  connectionStatus,
}: {
  c: Palette;
  devices: DeviceOption[];
  activeDeviceId?: string | null;
  connectionStatus: string;
}) {
  const candidates = useMemo(
    () => devices.filter((device) => (device.online || device.id === activeDeviceId) && device.deviceClass !== "edge-mobile"),
    [devices, activeDeviceId],
  );
  const [targetIds, setTargetIds] = useState<string[]>(activeDeviceId ? [activeDeviceId] : []);
  const [rowsByTarget, setRowsByTarget] = useState<Record<string, SourceStatusRow>>({});

  useEffect(() => {
    if (!activeDeviceId) return;
    setTargetIds((current) => (current.length ? current : [activeDeviceId]));
  }, [activeDeviceId]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (connectionStatus !== "connected") return;
      const next: Record<string, SourceStatusRow> = {};
      for (const targetId of targetIds) {
        const target = targetId === activeDeviceId ? undefined : targetId;
        try {
          const repos = await quicClient.listRepos(target);
          const repo = pickYaverRepo(repos);
          if (!repo) {
            next[targetId] = { repo: null, git: null, error: "No yaver.io checkout found." };
            continue;
          }
          const git = await quicClient.gitStatus(repo.path, target);
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
  }, [activeDeviceId, connectionStatus, targetIds]);

  return (
    <View style={{ marginTop: 16 }}>
      <Text style={{ color: c.textPrimary, fontWeight: "700", fontSize: 15 }}>Source code status</Text>
      <Text style={{ color: c.textMuted, fontSize: 12, marginTop: 4 }}>
        Dogfood audit for the live `yaver.io` checkout: branch, commit, dirty state, and origin drift on connected and peer machines.
      </Text>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        {candidates.length === 0 ? (
          <Text style={{ color: c.textMuted, fontSize: 11 }}>
            {connectionStatus === "connected" ? "No online machines reported source status yet." : "Connect to a machine to inspect source status."}
          </Text>
        ) : (
          candidates.map((device) => {
            const selected = targetIds.includes(device.id);
            return (
              <Pressable
                key={device.id}
                onPress={() =>
                  setTargetIds((current) =>
                    current.includes(device.id)
                      ? current.filter((id) => id !== device.id)
                      : [...current, device.id],
                  )
                }
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: selected ? c.accent : c.border,
                  backgroundColor: selected ? `${c.accent}22` : c.bg,
                }}
              >
                <Text style={{ color: selected ? c.accent : c.textPrimary, fontWeight: "600", fontSize: 12 }}>
                  {device.name || device.id}
                </Text>
                <Text style={{ color: c.textMuted, fontSize: 10, marginTop: 2 }}>
                  {device.id === activeDeviceId ? "connected host" : "live peer"} · {device.os || "machine"}
                </Text>
              </Pressable>
            );
          })
        )}
      </View>

      <View style={{ marginTop: 12, gap: 8 }}>
        {targetIds.map((targetId) => {
          const device = candidates.find((row) => row.id === targetId);
          const row = rowsByTarget[targetId];
          return (
            <View
              key={targetId}
              style={{
                borderWidth: 1,
                borderColor: c.border,
                backgroundColor: c.bgCardElevated,
                borderRadius: 10,
                padding: 10,
                gap: 4,
              }}
            >
              <Text style={{ color: c.textPrimary, fontWeight: "700", fontSize: 12 }}>
                {device?.name || targetId}
              </Text>
              {!row ? (
                <Text style={{ color: c.textMuted, fontSize: 11 }}>Loading source status…</Text>
              ) : row.error ? (
                <Text style={{ color: c.error, fontSize: 11 }}>{row.error}</Text>
              ) : row.repo && row.git ? (
                <>
                  <Text style={{ color: c.textMuted, fontSize: 11 }}>Path: {row.repo.path}</Text>
                  <Text style={{ color: c.textMuted, fontSize: 11 }}>Branch: {row.git.branch || row.repo.branch || "unknown"}</Text>
                  <Text style={{ color: c.textMuted, fontSize: 11 }}>Commit: {formatCommit(row.repo.lastCommit)}</Text>
                  <Text style={{ color: row.git.clean ? c.success : c.accent, fontSize: 11 }}>
                    {row.git.clean ? "Clean" : "Dirty"} · {row.git.ahead || 0} ahead · {row.git.behind || 0} behind
                  </Text>
                  <Text style={{ color: c.textMuted, fontSize: 11 }}>{providerLabel(row.repo.remote)}: {row.repo.remote || "none"}</Text>
                </>
              ) : (
                <Text style={{ color: c.textMuted, fontSize: 11 }}>No source status loaded.</Text>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}
