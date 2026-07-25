"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  agentClient,
  type RemoteRuntimeCapabilities,
  type RemoteRuntimeSession,
  type RemoteRuntimeTarget,
  type TmuxSessionSummary,
} from "@/lib/agent-client";
import RemoteRuntimeViewer from "./RemoteRuntimeViewer";

type Project = {
  name: string;
  path: string;
  framework?: string;
  executionMode?: string;
};

export type RuntimeLabIntent = {
  nonce: number;
  kind: "runtime" | "tmux";
  projectQuery?: string;
  surface?: string;
  platform?: string;
  tmuxQuery?: string;
};

function targetIdFor(surface?: string, platform?: string): string {
  const s = String(surface || "").toLowerCase();
  const p = String(platform || "").toLowerCase();
  if (s === "watch" && (p === "ios" || p === "watchos")) return "watchos-simulator";
  if (s === "watch" && (p === "android" || p === "wear" || p === "wearos")) return "android-wear";
  if (s === "tv" && (p === "ios" || p === "tvos")) return "tvos-simulator";
  if (s === "tv" && p === "android") return "android-tv";
  if ((s === "vision" || s === "xr") && (p === "ios" || p === "visionos")) return "visionos-simulator";
  if ((s === "vision" || s === "xr") && p === "android") return "android-xr";
  if (s === "phone" && p === "android") return "android-emulator";
  if (s === "phone" || p === "ios") return "ios-simulator";
  return "";
}

function projectMatches(project: Project, query?: string): boolean {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return false;
  return project.name.toLowerCase().includes(q) || project.path.toLowerCase().includes(q);
}

function targetSort(a: RemoteRuntimeTarget, b: RemoteRuntimeTarget): number {
  const surfaceOrder = ["browser", "phone", "tablet", "watch", "tv", "vision", "car", "desktop"];
  const ai = surfaceOrder.indexOf(String(a.surface || ""));
  const bi = surfaceOrder.indexOf(String(b.surface || ""));
  if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  return a.label.localeCompare(b.label);
}

export default function RuntimeLabView({
  intent,
  onOpenTmux,
}: {
  intent?: RuntimeLabIntent | null;
  onOpenTmux?: (sessionName: string) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [caps, setCaps] = useState<RemoteRuntimeCapabilities | null>(null);
  const [session, setSession] = useState<RemoteRuntimeSession | null>(null);
  const [tmuxSessions, setTmuxSessions] = useState<TmuxSessionSummary[]>([]);
  const [selectedTmux, setSelectedTmux] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedProject = useMemo(
    () => projects.find((p) => p.path === selectedPath) || null,
    [projects, selectedPath],
  );

  const appendLog = useCallback((line: string) => {
    const stamp = new Date().toLocaleTimeString();
    setLog((prev) => [...prev.slice(-160), `[${stamp}] ${line}`]);
  }, []);

  const refreshTmux = useCallback(async () => {
    try {
      const rows = await agentClient.listTmuxSessions();
      setTmuxSessions(rows);
      if (!selectedTmux && rows[0]?.name) setSelectedTmux(rows[0].name);
    } catch (err) {
      appendLog(`tmux list failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [appendLog, selectedTmux]);

  const loadProjects = useCallback(async () => {
    setError(null);
    try {
      const rows = await agentClient.listProjects();
      setProjects(rows);
      if (!selectedPath && rows[0]?.path) setSelectedPath(rows[0].path);
      appendLog(`projects loaded: ${rows.length}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load projects.");
    }
  }, [appendLog, selectedPath]);

  useEffect(() => {
    void loadProjects();
    void refreshTmux();
  }, [loadProjects, refreshTmux]);

  const loadCapabilities = useCallback(async (project: Project | null = selectedProject) => {
    if (!project) return;
    setBusy(true);
    setError(null);
    setCaps(null);
    setSession(null);
    appendLog(`capabilities ${project.name} ${project.framework || "unknown"}`);
    try {
      const next = await agentClient.getRemoteRuntimeCapabilities(project.path, project.framework || "");
      next.targets = [...(next.targets || [])].sort(targetSort);
      setCaps(next);
      appendLog(`targets: ${next.targets.map((t) => `${t.id}${t.enabled ? "" : " disabled"}`).join(", ")}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load runtime capabilities.");
    } finally {
      setBusy(false);
    }
  }, [appendLog, selectedProject]);

  const createSession = useCallback(async (targetId: string) => {
    if (!selectedProject) return;
    setBusy(true);
    setError(null);
    appendLog(`create session ${targetId}`);
    try {
      const next = await agentClient.startRemoteRuntimeSession(
        selectedProject.path,
        selectedProject.framework || "",
        targetId,
        "direct-webrtc",
      );
      setSession(next);
      appendLog(`session ${next.id} ${next.status} ${next.transportMode || ""}`);
      try {
        const frame = await agentClient.fetchRemoteRuntimeFrame(next.id);
        appendLog(`first frame ok: ${frame.type || "image"} ${frame.size} bytes`);
      } catch (err) {
        appendLog(`first frame failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create runtime session.");
    } finally {
      setBusy(false);
    }
  }, [appendLog, selectedProject]);

  useEffect(() => {
    if (!intent || intent.kind !== "runtime" || projects.length === 0) return;
    const project = projects.find((p) => projectMatches(p, intent.projectQuery)) || projects[0];
    setSelectedPath(project.path);
    void (async () => {
      await loadCapabilities(project);
      const wanted = targetIdFor(intent.surface, intent.platform);
      if (!wanted) return;
      const nextCaps = await agentClient.getRemoteRuntimeCapabilities(project.path, project.framework || "");
      const target = nextCaps.targets.find((t) => t.id === wanted);
      if (!target) {
        appendLog(`chat target not found: ${wanted}`);
        return;
      }
      if (!target.enabled) {
        setError(target.reason || `${target.label} is unavailable.`);
        appendLog(`chat target disabled: ${target.reason || wanted}`);
        return;
      }
      await createSession(wanted);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent?.nonce, projects.length]);

  useEffect(() => {
    if (!intent || intent.kind !== "tmux" || tmuxSessions.length === 0) return;
    const q = String(intent.tmuxQuery || intent.projectQuery || "").toLowerCase();
    const found = tmuxSessions.find((s) => s.name.toLowerCase().includes(q))
      || tmuxSessions.find((s) => String(s.agentType || "").toLowerCase().includes(q))
      || tmuxSessions[0];
    if (found?.name) {
      setSelectedTmux(found.name);
      appendLog(`chat selected tmux ${found.name}`);
      onOpenTmux?.(found.name);
    }
  }, [appendLog, intent, onOpenTmux, tmuxSessions]);

  async function adoptTmux(row: TmuxSessionSummary, pane?: string) {
    setBusy(true);
    setError(null);
    appendLog(`adopt tmux ${row.name}${pane ? ` ${pane}` : ""}`);
    try {
      const res = await agentClient.adoptTmuxSession(row.name, pane);
      appendLog(`adopted ${res.session} as task ${res.taskId}`);
      await refreshTmux();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not adopt tmux session.");
    } finally {
      setBusy(false);
    }
  }

  async function detachTmux(row: TmuxSessionSummary) {
    if (!row.taskId) return;
    setBusy(true);
    appendLog(`detach tmux task ${row.taskId}`);
    try {
      await agentClient.detachTmuxTask(row.taskId);
      appendLog(`detached ${row.name}; tmux kept running`);
      await refreshTmux();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not detach tmux task.");
    } finally {
      setBusy(false);
    }
  }

  async function closeTmux(row: TmuxSessionSummary) {
    if (!row.taskId) return;
    const ok = window.confirm(`Close tmux "${row.name}"? This terminates the adopted pane/session. Detach keeps it running.`);
    if (!ok) return;
    setBusy(true);
    appendLog(`close tmux task ${row.taskId}`);
    try {
      await agentClient.closeTmuxTask(row.taskId);
      appendLog(`closed ${row.name}`);
      await refreshTmux();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not close tmux task.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full min-h-0 gap-3 p-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-h-0 space-y-3 overflow-y-auto">
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[260px] flex-1">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-surface-500">Project</span>
            <select
              value={selectedPath}
              onChange={(e) => { setSelectedPath(e.target.value); setCaps(null); setSession(null); }}
              className="w-full rounded-md border border-surface-800 bg-surface-950 px-3 py-2 text-sm text-surface-100"
            >
              {projects.map((p) => (
                <option key={p.path} value={p.path}>{p.name} · {p.framework || "unknown"}</option>
              ))}
            </select>
          </label>
          <button
            disabled={!selectedProject || busy}
            onClick={() => void loadCapabilities()}
            className="rounded-md bg-surface-100 px-3 py-2 text-xs font-semibold text-surface-900 disabled:opacity-40"
          >
            Load Targets
          </button>
          <button
            disabled={busy}
            onClick={() => void refreshTmux()}
            className="rounded-md border border-surface-700 px-3 py-2 text-xs font-semibold text-surface-200 disabled:opacity-40"
          >
            Refresh tmux
          </button>
        </div>

        {error ? (
          <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-700 dark:text-rose-200">{error}</div>
        ) : null}

        {caps ? (
          <div className="space-y-2">
            <div className="text-xs text-surface-500">
              {caps.executionMode} · {caps.primarySurface} · {caps.currentHostClass || "host unknown"}
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {caps.targets.map((target) => (
                <div key={target.id} className="rounded-md border border-surface-800 bg-surface-900/60 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-surface-100">{target.label}</div>
                      <div className="mt-1 text-xs text-surface-500">
                        {target.surface || "runtime"} · {target.id} · {target.requiredCli || "tools"}
                      </div>
                    </div>
                    <button
                      disabled={!target.enabled || busy}
                      onClick={() => void createSession(target.id)}
                      className="rounded-md bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-700 disabled:cursor-not-allowed disabled:opacity-40 dark:text-amber-200"
                    >
                      {target.enabled ? "Open" : "Unavailable"}
                    </button>
                  </div>
                  {target.reason ? <div className="mt-2 text-xs text-rose-700 dark:text-rose-300">{target.reason}</div> : null}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-surface-800 bg-surface-900/40 p-4 text-sm text-surface-500">
            Load targets to boot watchOS, Wear OS, TV, phone, browser, and other runtime surfaces from this machine.
          </div>
        )}

        {session ? (
          <div className="space-y-2">
            <div className="text-xs text-surface-500">
              session <span className="font-mono text-surface-300">{session.id}</span> · {session.targetLabel} · {session.status}
            </div>
            <RemoteRuntimeViewer session={session} onSessionChange={setSession} />
          </div>
        ) : null}
      </div>

      <aside className="min-h-0 space-y-3 overflow-y-auto border-t border-surface-800 pt-3 xl:border-l xl:border-t-0 xl:pl-3 xl:pt-0">
        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-surface-500">Tmux Sessions</div>
          <div className="space-y-2">
            {tmuxSessions.length === 0 ? (
              <div className="rounded-md border border-surface-800 bg-surface-900/50 p-3 text-xs text-surface-500">No tmux sessions reported.</div>
            ) : tmuxSessions.map((row) => (
              <div key={row.name} className={`rounded-md border p-3 ${selectedTmux === row.name ? "border-sky-500/40 bg-sky-500/10" : "border-surface-800 bg-surface-900/50"}`}>
                <button onClick={() => setSelectedTmux(row.name)} className="block w-full text-left">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-sm text-surface-100">{row.name}</span>
                    <span className="text-[10px] uppercase tracking-wide text-surface-500">{row.agentType || row.relationship || "tmux"}</span>
                  </div>
                  <pre className="mt-2 max-h-20 overflow-hidden whitespace-pre-wrap rounded bg-black/30 p-2 text-[10px] leading-4 text-surface-400">{row.panePreview || "(no pane preview)"}</pre>
                </button>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button onClick={() => onOpenTmux?.(row.name)} className="rounded bg-sky-500/15 px-2 py-1 text-[11px] font-semibold text-sky-700 dark:text-sky-200">Attach</button>
                  <button onClick={() => void adoptTmux(row)} disabled={busy} className="rounded bg-violet-500/15 px-2 py-1 text-[11px] font-semibold text-violet-700 disabled:opacity-40 dark:text-violet-200">Adopt</button>
                  {row.taskId ? (
                    <>
                      <button onClick={() => void detachTmux(row)} disabled={busy} className="rounded bg-emerald-500/15 px-2 py-1 text-[11px] font-semibold text-emerald-700 disabled:opacity-40 dark:text-emerald-200">Detach</button>
                      <button onClick={() => void closeTmux(row)} disabled={busy} className="rounded bg-rose-500/15 px-2 py-1 text-[11px] font-semibold text-rose-700 disabled:opacity-40 dark:text-rose-200">Close</button>
                    </>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-surface-500">Runtime Console</div>
          <pre className="h-64 overflow-auto rounded-md border border-surface-800 bg-black/50 p-3 text-[11px] leading-5 text-surface-300">
            {log.length ? log.join("\n") : "No runtime operations yet."}
          </pre>
        </div>
      </aside>
    </div>
  );
}
