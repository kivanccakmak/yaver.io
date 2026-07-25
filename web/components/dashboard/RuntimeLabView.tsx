"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  agentClient,
  type RemoteRuntimeCapabilities,
  type RemoteRuntimeSession,
  type RemoteRuntimeTarget,
} from "@/lib/agent-client";
import RemoteRuntimeViewer from "./RemoteRuntimeViewer";

type Project = {
  name: string;
  path: string;
  framework?: string;
  executionMode?: string;
  frameworks?: string[];
  stack?: string;
  surfaces?: string[];
  tags?: string[];
};

type WorkspaceRepo = {
  name: string;
  path: string;
  branch?: string;
  remote?: string;
  stack?: {
    type?: string;
    frameworks?: string[];
    services?: string[];
    actions?: string[];
  };
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

function projectFromRepo(repo: WorkspaceRepo): Project {
  const frameworks = repo.stack?.frameworks ?? [];
  const actions = repo.stack?.actions ?? [];
  const stackType = repo.stack?.type;
  const lower = new Set([stackType, ...frameworks, ...actions].filter(Boolean).map((v) => String(v).toLowerCase()));
  const surfaces = new Set<string>();
  if (lower.has("monorepo")) {
    surfaces.add("web");
    surfaces.add("mobile");
    surfaces.add("backend");
  }
  if (["expo", "react-native", "flutter", "swift", "kotlin", "mobile"].some((v) => lower.has(v))) surfaces.add("mobile");
  if (["next.js", "nextjs", "vite", "react", "web", "dev-server"].some((v) => lower.has(v))) surfaces.add("web");
  return {
    name: repo.name || repo.path.split(/[\\/]/).filter(Boolean).pop() || repo.path,
    path: repo.path,
    framework: stackType === "monorepo" ? "monorepo" : frameworks[0] || stackType,
    frameworks,
    stack: stackType,
    surfaces: Array.from(surfaces),
    executionMode: actions.includes("hot-reload") ? "native-webrtc" : actions.includes("dev-server") ? "web" : undefined,
    tags: [stackType, ...frameworks, ...actions].filter(Boolean) as string[],
  };
}

function mergeProjectInventory(projects: Project[], repos: WorkspaceRepo[]): Project[] {
  const byPath = new Map<string, Project>();
  for (const project of projects) {
    if (project.path) byPath.set(project.path, project);
  }
  for (const repo of repos) {
    if (!repo.path || byPath.has(repo.path)) continue;
    byPath.set(repo.path, projectFromRepo(repo));
  }
  return Array.from(byPath.values()).sort((a, b) => {
    const ay = `${a.name} ${a.path}`.toLowerCase().includes("yaver.io");
    const by = `${b.name} ${b.path}`.toLowerCase().includes("yaver.io");
    if (ay !== by) return ay ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function targetSort(a: RemoteRuntimeTarget, b: RemoteRuntimeTarget): number {
  const surfaceOrder = ["browser", "phone", "tablet", "watch", "tv", "vision", "car", "desktop"];
  const ai = surfaceOrder.indexOf(String(a.surface || ""));
  const bi = surfaceOrder.indexOf(String(b.surface || ""));
  if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  return a.label.localeCompare(b.label);
}

function isPrimaryRuntimeTarget(target: RemoteRuntimeTarget): boolean {
  if (!target.enabled) return false;
  const id = String(target.id || "").toLowerCase();
  const surface = String(target.surface || "").toLowerCase();
  if (surface === "browser") return true;
  if (["phone", "tablet"].includes(surface) && (id.includes("simulator") || id.includes("emulator"))) return true;
  if (id === "browser-window") return true;
  if (["ios-simulator", "ipados-simulator", "android-emulator"].includes(id)) return true;
  return false;
}

function runtimeTargetGroup(target: RemoteRuntimeTarget): "browser" | "simulator" | "container" | "device" | "advanced" | "unavailable" {
  if (!target.enabled) return "unavailable";
  const id = String(target.id || "").toLowerCase();
  const surface = String(target.surface || "").toLowerCase();
  if (surface === "browser" || id === "browser-window") return "browser";
  if (id.includes("redroid")) return "container";
  if (id.includes("device")) return "device";
  if (["phone", "tablet"].includes(surface) && (id.includes("simulator") || id.includes("emulator"))) return "simulator";
  if (id.includes("simulator") || id.includes("emulator")) return "advanced";
  return "advanced";
}

const runtimeGroupLabels: Record<ReturnType<typeof runtimeTargetGroup>, string> = {
  browser: "Browser",
  simulator: "Phone / tablet simulators",
  container: "Android containers",
  device: "Physical devices",
  advanced: "Watch / TV / XR / car",
  unavailable: "Unavailable",
};

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
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvancedTargets, setShowAdvancedTargets] = useState(false);
  const [webPreviewUrl, setWebPreviewUrl] = useState<string | null>(null);
  const [webPreviewBusy, setWebPreviewBusy] = useState(false);
  const [webPreviewNote, setWebPreviewNote] = useState<string | null>(null);

  const selectedProject = useMemo(
    () => projects.find((p) => p.path === selectedPath) || null,
    [projects, selectedPath],
  );

  const appendLog = useCallback((line: string) => {
    const stamp = new Date().toLocaleTimeString();
    setLog((prev) => [...prev.slice(-160), `[${stamp}] ${line}`]);
  }, []);

  const loadProjects = useCallback(async () => {
    setError(null);
    try {
      const [projectRows, repoRows] = await Promise.all([
        agentClient.listProjects(),
        agentClient.listWorkspaceRepos(),
      ]);
      const rows = mergeProjectInventory(projectRows, repoRows);
      setProjects(rows);
      if (!selectedPath && rows[0]?.path) setSelectedPath(rows[0].path);
      appendLog(`projects loaded: ${rows.length}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load projects.");
    }
  }, [appendLog, selectedPath]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

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
      const primaryCount = next.targets.filter(isPrimaryRuntimeTarget).length;
      appendLog(`targets: ${primaryCount} primary, ${Math.max(0, next.targets.length - primaryCount)} advanced/unavailable`);
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

  const openWebUI = useCallback(async () => {
    if (!selectedProject) return;
    setWebPreviewBusy(true);
    setWebPreviewNote(null);
    setError(null);
    appendLog(`web ui ${selectedProject.name}`);
    try {
      const framework = (selectedProject.framework || "").toLowerCase();
      const staticBundleFramework = ["expo", "react-native"].includes(framework);
      if (staticBundleFramework) {
        setWebPreviewNote(`Building ${selectedProject.name} web bundle...`);
        const built = await agentClient.buildWebJSBundle({
          projectName: selectedProject.name,
          projectPath: selectedProject.path,
        });
        if (!built.ok) throw new Error(built.error || "Could not build Web UI bundle.");
        const signedUrl = agentClient.webBundlePreviewUrl(built.bundleUrl);
        if (!signedUrl) throw new Error("No signed Web UI bundle URL is available.");
        setWebPreviewUrl(signedUrl);
        setWebPreviewNote(`Web UI bundle ready: ${built.fileCount} files.`);
        appendLog(`web ui ready ${signedUrl}`);
        return;
      }
      const response = await agentClient.startDevServer({
        framework: selectedProject.framework || "",
        workDir: selectedProject.path,
        platform: "web",
        surface: "web-reload",
      });
      if (response.mode === "static-bundle") {
        if (response.bundleReady && response.bundleUrl) {
          const signedUrl = agentClient.webBundlePreviewUrl(response.bundleUrl);
          if (!signedUrl) throw new Error("No signed Web UI bundle URL is available.");
          setWebPreviewUrl(signedUrl);
          setWebPreviewNote(response.bundleHint || "Web UI bundle ready.");
          appendLog(`web ui ready ${signedUrl}`);
          return;
        }
        const built = await agentClient.buildWebJSBundle({
          projectName: selectedProject.name,
          projectPath: selectedProject.path,
        });
        if (!built.ok) throw new Error(built.error || "Could not build Web UI bundle.");
        const signedUrl = agentClient.webBundlePreviewUrl(built.bundleUrl);
        if (!signedUrl) throw new Error("No signed Web UI bundle URL is available.");
        setWebPreviewUrl(signedUrl);
        setWebPreviewNote(`Web UI bundle ready: ${built.fileCount} files.`);
        appendLog(`web ui ready ${signedUrl}`);
        return;
      }
      const status = await agentClient.getDevServerStatus();
      const url =
        response.bundleUrl
          ? agentClient.webBundlePreviewUrl(response.bundleUrl)
          : status?.webPort && status.webPort > 0
          ? agentClient.devWebPreviewUrl
          : agentClient.devPreviewUrl;
      if (!url) throw new Error("No browser preview URL is available for this connection.");
      setWebPreviewUrl(url);
      setWebPreviewNote(response.bundleHint || status?.servingLabel || "Web UI running in this dashboard.");
      appendLog(`web ui ready ${url}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not open Web UI.";
      setWebPreviewNote(message);
      setError(message);
      appendLog(`web ui failed: ${message}`);
    } finally {
      setWebPreviewBusy(false);
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
    if (!intent || intent.kind !== "tmux") return;
    const q = String(intent.tmuxQuery || intent.projectQuery || "").trim();
    if (!q) return;
    appendLog(`chat requested tmux ${q}`);
    onOpenTmux?.(q);
  }, [appendLog, intent, onOpenTmux]);

  return (
    <div className="grid h-full min-h-0 gap-3 bg-[#f2f4f7] p-4 text-[#1f2933] dark:bg-[#101318] dark:text-[#e6e8ec] xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-h-0 space-y-3 overflow-y-auto">
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[260px] flex-1">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[#5d6673] dark:text-[#9aa3af]">Project</span>
            <select
              value={selectedPath}
              onChange={(e) => { setSelectedPath(e.target.value); setCaps(null); setSession(null); setWebPreviewUrl(null); setWebPreviewNote(null); }}
              className="w-full rounded-md border border-[#d7dce3] bg-white px-3 py-2 text-sm text-[#1f2933] dark:border-[#2a3039] dark:bg-[#161b22] dark:text-[#e6e8ec]"
            >
              {projects.map((p) => (
                <option key={p.path} value={p.path}>{p.name} · {p.framework || "unknown"}</option>
              ))}
            </select>
          </label>
          <button
            disabled={!selectedProject || busy}
            onClick={() => void loadCapabilities()}
            className="rounded-md bg-[#1f2933] px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
          >
            Load Targets
          </button>
        </div>

        {error ? (
          <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-700 dark:text-rose-200">{error}</div>
        ) : null}

        {caps ? (
          <div className="space-y-3">
            <div className="text-xs text-[#667085] dark:text-[#9aa3af]">
              {caps.executionMode} · {caps.primarySurface} · {caps.currentHostClass || "host unknown"}
            </div>
            {(() => {
              const enabledTargets = caps.targets.filter((target) => target.enabled);
              const groupedTargets = enabledTargets.reduce<Record<string, RemoteRuntimeTarget[]>>((acc, target) => {
                const group = runtimeTargetGroup(target);
                acc[group] = [...(acc[group] ?? []), target];
                return acc;
              }, {});
              const unavailableTargets = caps.targets.filter((target) => !target.enabled);
              const primaryTargets = caps.targets.filter(isPrimaryRuntimeTarget);
              const groupOrder: ReturnType<typeof runtimeTargetGroup>[] = ["browser", "simulator", "container", "device", "advanced"];
              const renderTarget = (target: RemoteRuntimeTarget, compact = false) => (
                <div key={target.id} className={`rounded-md border p-3 ${target.enabled ? "border-[#d7dce3] bg-white dark:border-[#2a3039] dark:bg-[#161b22]" : "border-[#e1e5eb] bg-[#f8fafc] dark:border-[#252b33] dark:bg-[#121720]"}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className={`text-sm font-medium ${target.enabled ? "text-[#1f2933] dark:text-[#e6e8ec]" : "text-[#667085] dark:text-[#8b949e]"}`}>{target.label}</div>
                      <div className="mt-1 text-xs text-[#667085] dark:text-[#9aa3af]">
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
                  {target.reason ? (
                    <div className={`mt-2 text-xs ${compact ? "text-surface-500" : "text-rose-700 dark:text-rose-300"}`}>{target.reason}</div>
                  ) : null}
                </div>
              );
              const renderGroup = (group: ReturnType<typeof runtimeTargetGroup>, targets: RemoteRuntimeTarget[]) => {
                if (targets.length === 0) return null;
                return (
                  <section key={group} className="space-y-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-[#5d6673] dark:text-[#9aa3af]">
                      {runtimeGroupLabels[group]}
                    </div>
                    <div className="grid gap-2 md:grid-cols-2">
                      {targets.map((target) => renderTarget(target))}
                    </div>
                  </section>
                );
              };
              return (
                <>
                  <section className="space-y-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-[#5d6673] dark:text-[#9aa3af]">
                      Browser
                    </div>
                    <div className="grid gap-2 md:grid-cols-2">
                      <div className="rounded-md border border-[#d7dce3] bg-white p-3 dark:border-[#2a3039] dark:bg-[#161b22]">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-medium text-[#1f2933] dark:text-[#e6e8ec]">Web UI in browser</div>
                            <div className="mt-1 text-xs text-[#667085] dark:text-[#9aa3af]">
                              browser · direct iframe · dev server
                            </div>
                          </div>
                          <button
                            disabled={!selectedProject || webPreviewBusy}
                            onClick={() => void openWebUI()}
                            className="rounded-md bg-sky-500/15 px-3 py-1.5 text-xs font-semibold text-sky-700 disabled:cursor-not-allowed disabled:opacity-40 dark:text-sky-200"
                          >
                            {webPreviewBusy ? "Opening..." : "Open"}
                          </button>
                        </div>
                        {webPreviewNote ? <div className="mt-2 text-xs text-[#667085] dark:text-[#9aa3af]">{webPreviewNote}</div> : null}
                      </div>
                      {(groupedTargets.browser ?? []).map((target) => renderTarget(target))}
                    </div>
                  </section>
                  {webPreviewUrl ? (
                    <section className="space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-[#5d6673] dark:text-[#9aa3af]">Web UI</div>
                        <button
                          onClick={() => setWebPreviewUrl(null)}
                          className="rounded-md border border-[#d7dce3] bg-white px-2 py-1 text-[11px] text-[#475467] dark:border-[#2a3039] dark:bg-[#161b22] dark:text-[#d7dce3]"
                        >
                          Close
                        </button>
                      </div>
                      <iframe
                        src={webPreviewUrl}
                        className="h-[520px] w-full rounded-md border border-[#d7dce3] bg-white"
                        title="Project Web UI preview"
                      />
                    </section>
                  ) : null}
                  {primaryTargets.length === 0 && enabledTargets.length > 0 ? (
                    <div className="grid gap-2 md:grid-cols-2">
                      {enabledTargets.map((target) => renderTarget(target))}
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {groupOrder.filter((group) => group !== "browser").map((group) => renderGroup(group, groupedTargets[group] ?? []))}
                    </div>
                  )}
                  {unavailableTargets.length ? (
                    <div className="rounded-md border border-[#d7dce3] bg-[#f8fafc] dark:border-[#2a3039] dark:bg-[#121720]">
                      <button
                        type="button"
                        onClick={() => setShowAdvancedTargets((v) => !v)}
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
                      >
                        <span className="text-xs font-semibold uppercase tracking-wide text-[#5d6673] dark:text-[#9aa3af]">
                          Unavailable targets
                        </span>
                        <span className="text-xs text-[#667085] dark:text-[#9aa3af]">
                          {unavailableTargets.length} {showAdvancedTargets ? "hide" : "show"}
                        </span>
                      </button>
                      {showAdvancedTargets ? (
                        <div className="grid gap-2 border-t border-[#d7dce3] p-3 dark:border-[#2a3039] md:grid-cols-2">
                          {unavailableTargets.map((target) => renderTarget(target, true))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </>
              );
            })()}
          </div>
        ) : (
          <div className="rounded-md border border-[#d7dce3] bg-white p-4 text-sm text-[#667085] dark:border-[#2a3039] dark:bg-[#161b22] dark:text-[#9aa3af]">
            Load targets to boot watchOS, Wear OS, TV, phone, browser, and other runtime surfaces from this machine.
          </div>
        )}

        {session ? (
          <div className="space-y-2">
            <div className="text-xs text-[#667085] dark:text-[#9aa3af]">
              session <span className="font-mono text-[#344054] dark:text-[#d7dce3]">{session.id}</span> · {session.targetLabel} · {session.status}
            </div>
            <RemoteRuntimeViewer session={session} onSessionChange={setSession} />
          </div>
        ) : null}
      </div>

      <aside className="min-h-0 space-y-3 overflow-y-auto border-t border-[#d7dce3] pt-3 dark:border-[#2a3039] xl:border-l xl:border-t-0 xl:pl-3 xl:pt-0">
        <div className="rounded-md border border-[#d7dce3] bg-white p-3 dark:border-[#2a3039] dark:bg-[#161b22]">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#5d6673] dark:text-[#9aa3af]">Vibing</div>
          <div className="text-sm font-medium text-[#1f2933] dark:text-[#e6e8ec]">Render lane activity</div>
          <div className="mt-1 text-xs text-[#667085] dark:text-[#9aa3af]">
            Browser bundles and WebRTC simulator sessions report here. Agent chats stay in the Vibing panel.
          </div>
        </div>
        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[#5d6673] dark:text-[#9aa3af]">Runtime Console</div>
          <pre className="h-64 overflow-auto rounded-md border border-[#1f2933] bg-[#111318] p-3 text-[11px] leading-5 text-[#d5dae1]">
            {log.length ? log.join("\n") : "No runtime operations yet."}
          </pre>
        </div>
      </aside>
    </div>
  );
}
