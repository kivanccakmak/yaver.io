"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { agentClient, type RemoteRuntimeCapabilities, type RemoteRuntimeSession, type RemoteRuntimeTarget } from "@/lib/agent-client";
import EnvironmentSwitcher from "./EnvironmentSwitcher";
import RemoteRuntimeViewer from "./RemoteRuntimeViewer";

type ProjectSummary = {
  name: string;
  path: string;
  branch?: string;
  framework?: string;
  frameworks?: string[];
  stack?: string;
  stacks?: string[];
  surfaces?: string[];
  testSurfaces?: string[];
  backend?: string;
  services?: string[];
  hosting?: string[];
  role?: string;
  executionMode?: string;
  primarySurface?: string;
  gitRemote?: string;
  tags?: string[];
};

type WorkspaceRepo = {
  name: string;
  path: string;
  branch?: string;
  remote?: string;
  dirty?: boolean;
  stack?: {
    type?: string;
    frameworks?: string[];
    services?: string[];
    actions?: string[];
  };
};

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function unique(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((v) => String(v || "").trim()).filter(Boolean)));
}

function supportsWebUI(project: ProjectSummary | null): boolean {
  const terms = unique([
    project?.framework,
    ...(project?.frameworks ?? []),
    project?.stack,
    ...(project?.stacks ?? []),
    ...(project?.surfaces ?? []),
    ...(project?.tags ?? []),
  ]).map((v) => v.toLowerCase());
  return terms.some((v) => ["web", "browser", "webview", "next", "nextjs", "vite", "react", "expo", "react-native", "flutter"].includes(v));
}

function projectTerms(project: ProjectSummary | null): Set<string> {
  const terms = new Set<string>();
  for (const raw of [
    project?.name,
    project?.path,
    project?.framework,
    ...(project?.frameworks ?? []),
    project?.stack,
    ...(project?.stacks ?? []),
    ...(project?.surfaces ?? []),
    ...(project?.testSurfaces ?? []),
    ...(project?.tags ?? []),
    project?.executionMode,
  ]) {
    const value = String(raw || "").trim().toLowerCase().replace(/\s+/g, "-").replace(/\./g, "");
    if (!value) continue;
    terms.add(value);
    for (const part of value.split(/[^a-z0-9]+/).filter(Boolean)) terms.add(part);
  }
  return terms;
}

function termsContain(terms: Set<string>, candidates: string[]): boolean {
  const all = Array.from(terms);
  return candidates.some((candidate) => terms.has(candidate) || all.some((term) => term.includes(candidate)));
}

function runtimeFrameworkForProject(project: ProjectSummary | null): string {
  const explicit = String(project?.framework || "").trim().toLowerCase();
  if (["expo", "react-native", "flutter", "swift", "kotlin", "browser", "desktop"].includes(explicit)) return explicit;
  const terms = projectTerms(project);
  if (termsContain(terms, ["web", "browser", "next", "nextjs", "vite"])) return "browser";
  if (termsContain(terms, ["flutter"])) return "flutter";
  if (termsContain(terms, ["expo"])) return "expo";
  if (termsContain(terms, ["react-native"])) return "react-native";
  if (termsContain(terms, ["swift"])) return "swift";
  if (termsContain(terms, ["kotlin"])) return "kotlin";
  return explicit;
}

function browserPreviewFrameworkForProject(project: ProjectSummary | null): string {
  const explicit = String(project?.framework || "").trim().toLowerCase().replace(/\s+/g, "-").replace(/\./g, "");
  if (["next", "nextjs", "vite", "react", "expo", "react-native", "flutter"].includes(explicit)) {
    return explicit === "next" ? "nextjs" : explicit;
  }
  const terms = projectTerms(project);
  if (["", "repo", "monorepo", "unknown"].includes(explicit)) {
    if (termsContain(terms, ["next", "nextjs"])) return "nextjs";
    if (termsContain(terms, ["vite"])) return "vite";
    if (termsContain(terms, ["web", "browser"])) return "react";
  }
  if (termsContain(terms, ["expo"])) return "expo";
  if (termsContain(terms, ["react-native"])) return "react-native";
  if (termsContain(terms, ["flutter"])) return "flutter";
  if (termsContain(terms, ["next", "nextjs"])) return "nextjs";
  if (termsContain(terms, ["vite"])) return "vite";
  if (termsContain(terms, ["react"])) return "react";
  return project?.framework || "";
}

function isMonorepoProject(project: ProjectSummary | null): boolean {
  return String(project?.framework || project?.stack || "").trim().toLowerCase() === "monorepo";
}

async function monorepoWebAppName(project: ProjectSummary | null): Promise<string | undefined> {
  if (!project || !isMonorepoProject(project)) return undefined;
  try {
    const apps = await agentClient.getWorkspaceApps("web", project.path);
    const app = apps.find((candidate) => candidate.exists && candidate.name === "web") ||
      apps.find((candidate) => candidate.exists && candidate.kind === "web") ||
      apps.find((candidate) => candidate.exists);
    return app?.name;
  } catch {
    return undefined;
  }
}

function signedBundlePreviewUrl(bundleUrl?: string): string | null {
  if (!bundleUrl) return null;
  try {
    const parsed = new URL(bundleUrl, "http://agent.local");
    if (!parsed.searchParams.has("sig") && !parsed.searchParams.has("signature") && !parsed.searchParams.has("token")) {
      return null;
    }
  } catch {
    return null;
  }
  return agentClient.webBundlePreviewUrl(bundleUrl);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForDevPreviewUrl(bundleUrl?: string): Promise<{ url: string; note: string }> {
  const signedUrl = signedBundlePreviewUrl(bundleUrl);
  if (signedUrl) return { url: signedUrl, note: "Web UI bundle ready." };
  let lastError = "";
  for (let i = 0; i < 16; i++) {
    const status = await agentClient.getDevServerStatus();
    if (status?.error) lastError = status.error;
    if (status?.webPort && status.webPort > 0 && agentClient.devWebPreviewUrl) {
      const probed = await probePreviewUrl(agentClient.devWebPreviewUrl);
      if (probed.ok) return { url: agentClient.devWebPreviewUrl, note: status.servingLabel || "Web UI running." };
      lastError = probed.error;
    }
    if ((status?.running || status?.serving || (status?.port ?? 0) > 0) && agentClient.devPreviewUrl) {
      const probed = await probePreviewUrl(agentClient.devPreviewUrl);
      if (probed.ok) return { url: agentClient.devPreviewUrl, note: status?.servingLabel || "Web UI running." };
      lastError = probed.error;
    }
    await sleep(750);
  }
  throw new Error(lastError || "The agent accepted the Web UI start request, but no browser preview is running yet.");
}

async function probePreviewUrl(url: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { headers: { Accept: "text/html,application/xhtml+xml" }, cache: "no-store" });
    const text = await res.clone().text().catch(() => "");
    if (!res.ok) return { ok: false, error: `Preview URL returned HTTP ${res.status}` };
    if (/no dev server running|dev bundle URL must be signed/i.test(text)) {
      return { ok: false, error: text.trim().slice(0, 180) || "Preview URL is not ready." };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Preview URL is not reachable yet." };
  }
}

function surfaceLabel(value?: string): string {
  const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, "-").replace(/\./g, "");
  if (normalized === "hermes") return "native bundle";
  if (normalized === "rn-hermes") return "react native bundle";
  return value || "";
}

function projectFromRepo(repo: WorkspaceRepo): ProjectSummary {
  const frameworks = repo.stack?.frameworks ?? [];
  const services = repo.stack?.services ?? [];
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
  if (["go", "python", "rust", "backend"].some((v) => lower.has(v))) surfaces.add("backend");
  return {
    name: repo.name || basename(repo.path),
    path: repo.path,
    branch: repo.branch,
    framework: stackType === "monorepo" ? "monorepo" : frameworks[0] || stackType,
    frameworks,
    stack: stackType,
    stacks: [stackType, ...frameworks].filter(Boolean) as string[],
    surfaces: Array.from(surfaces),
    services,
    hosting: services.filter((v) => ["cloudflare", "vercel", "netlify"].includes(v)),
    role: stackType === "monorepo" ? "repo" : stackType || "repo",
    executionMode: actions.includes("hot-reload") ? "native-webrtc" : actions.includes("dev-server") ? "web" : undefined,
    primarySurface: surfaces.has("web") ? "web" : surfaces.has("mobile") ? "mobile" : stackType,
    gitRemote: repo.remote,
    tags: [stackType, ...frameworks, ...services, ...actions, repo.dirty ? "dirty" : undefined].filter(Boolean) as string[],
  };
}

function targetGroup(target: RemoteRuntimeTarget): "browser" | "simulator" | "container" | "device" | "advanced" | "unavailable" {
  if (!target.enabled) return "unavailable";
  const id = String(target.id || "").toLowerCase();
  const surface = String(target.surface || "").toLowerCase();
  if (surface === "browser" || id === "browser-window") return "browser";
  if (id.includes("redroid")) return "container";
  if (id.includes("device")) return "device";
  if (["phone", "tablet"].includes(surface) && (id.includes("simulator") || id.includes("emulator"))) return "simulator";
  return "advanced";
}

const targetGroupLabels: Record<ReturnType<typeof targetGroup>, string> = {
  browser: "Browser",
  simulator: "Phone / tablet simulators",
  container: "Android containers",
  device: "Physical devices",
  advanced: "Watch / TV / XR / car",
  unavailable: "Unavailable",
};

export default function ProjectDetailView({ directory, onClose }: { directory: string; onClose: () => void }) {
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [caps, setCaps] = useState<RemoteRuntimeCapabilities | null>(null);
  const [session, setSession] = useState<RemoteRuntimeSession | null>(null);
  const [webPreviewUrl, setWebPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const slug = basename(directory);
  const stackLabels = useMemo(() => unique([
    project?.framework,
    ...(project?.frameworks ?? []),
    project?.stack,
    ...(project?.stacks ?? []),
    project?.backend,
    ...(project?.services ?? []),
    ...(project?.hosting ?? []),
  ]), [project]);
  const surfaceLabels = useMemo(() => unique([
    ...(project?.surfaces ?? []),
    ...(project?.testSurfaces ?? []),
    project?.primarySurface,
    project?.executionMode,
  ]), [project]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [rows, repos] = await Promise.all([
          agentClient.listProjects(),
          agentClient.listWorkspaceRepos(),
        ]);
        const found = rows.find((p) => p.path === directory) || rows.find((p) => basename(p.path) === slug);
        const repo = repos.find((p) => p.path === directory) || repos.find((p) => basename(p.path) === slug);
        if (mounted) setProject(found || (repo ? projectFromRepo(repo) : { name: slug, path: directory }));
      } catch {
        if (mounted) setProject({ name: slug, path: directory });
      }
    })();
    return () => { mounted = false; };
  }, [directory, slug]);

  async function openWebUI() {
    setBusy("web");
    setMessage(null);
    try {
      const framework = browserPreviewFrameworkForProject(project);
      const staticBundleFramework = ["expo", "react-native"].includes(framework.toLowerCase());
      if (staticBundleFramework) {
        setMessage(`Building ${project?.name || slug} web bundle...`);
        const built = await agentClient.buildWebJSBundle({ projectName: project?.name || slug, projectPath: directory });
        if (!built.ok) throw new Error(built.error || "Could not build Web UI bundle.");
        const signedUrl = agentClient.webBundlePreviewUrl(built.bundleUrl);
        if (!signedUrl) throw new Error("No signed Web UI bundle URL is available.");
        setWebPreviewUrl(signedUrl);
        setMessage(`Web UI bundle ready: ${built.fileCount} files.`);
        return;
      }
      const app = await monorepoWebAppName(project);
      const response = await agentClient.startDevServer(app ? {
        app,
        root: directory,
        platform: "web",
        surface: "web-reload",
      } : {
        framework,
        workDir: directory,
        platform: "web",
        surface: "web-reload",
      });
      if (response.mode === "static-bundle") {
        const existingSignedUrl = signedBundlePreviewUrl(response.bundleUrl);
        if (response.bundleReady && existingSignedUrl) {
          setWebPreviewUrl(existingSignedUrl);
          setMessage(response.bundleHint || "Web UI bundle ready.");
          return;
        }
        const built = await agentClient.buildWebJSBundle({ projectName: project?.name || slug, projectPath: directory });
        if (!built.ok) throw new Error(built.error || "Could not build Web UI bundle.");
        const signedUrl = agentClient.webBundlePreviewUrl(built.bundleUrl);
        if (!signedUrl) throw new Error("No signed Web UI bundle URL is available.");
        setWebPreviewUrl(signedUrl);
        setMessage(`Web UI bundle ready: ${built.fileCount} files.`);
        return;
      }
      const preview = await waitForDevPreviewUrl(response.bundleUrl);
      setWebPreviewUrl(preview.url);
      setMessage(response.bundleHint || preview.note);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not open Web UI.");
    } finally {
      setBusy(null);
    }
  }

  async function loadRuntimeTargets() {
    setBusy("targets");
    setMessage(null);
    setSession(null);
    try {
      const next = await agentClient.getRemoteRuntimeCapabilities(directory, runtimeFrameworkForProject(project));
      setCaps({ ...next, targets: [...(next.targets || [])] });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not load render targets.");
    } finally {
      setBusy(null);
    }
  }

  async function openRuntimeTarget(target: RemoteRuntimeTarget) {
    setBusy(target.id);
    setMessage(null);
    try {
      const next = await agentClient.startRemoteRuntimeSession(directory, runtimeFrameworkForProject(project), target.id, "direct-webrtc");
      setSession(next);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not open runtime target.");
    } finally {
      setBusy(null);
    }
  }

  const groupedTargets = useMemo(() => {
    const groups: Record<string, RemoteRuntimeTarget[]> = {};
    for (const target of caps?.targets ?? []) {
      const group = targetGroup(target);
      groups[group] = [...(groups[group] ?? []), target];
    }
    return groups;
  }, [caps]);

  return (
    <div className="min-h-full bg-[#f2f4f7] p-4 text-[#1f2933] dark:bg-[#101318] dark:text-[#e6e8ec]">
      <div className="mb-4 flex items-center gap-3">
        <button onClick={onClose} className="text-sm font-medium text-[#475467] hover:text-[#1f2933] dark:text-[#a7b0bc] dark:hover:text-white">← Projects</button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-mono text-xl font-semibold text-[#1f2933] dark:text-[#e6e8ec]">{project?.name || slug}</h2>
          <div className="truncate font-mono text-xs text-[#667085] dark:text-[#9aa3af]">{directory}</div>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
        <main className="space-y-3">
          <section className="space-y-2">
            <SectionLabel>Render</SectionLabel>
            <div className="grid gap-2 md:grid-cols-2">
              <ActionCard
                title="Web UI in browser"
                meta="browser · direct iframe · dev server"
                disabled={!supportsWebUI(project) || busy !== null}
                busy={busy === "web"}
                onClick={openWebUI}
              />
              <ActionCard
                title="Load simulator targets"
                meta="WebRTC · simulator / browser / Redroid"
                disabled={busy !== null}
                busy={busy === "targets"}
                onClick={loadRuntimeTargets}
              />
            </div>
            {message ? <div className="rounded-md border border-[#d7dce3] bg-white px-3 py-2 text-xs text-[#475467] dark:border-[#2a3039] dark:bg-[#161b22] dark:text-[#c5ccd6]">{message}</div> : null}
            {busy === "targets" && !caps ? (
              <div className="rounded-md border border-[#d7dce3] bg-white px-3 py-2 text-xs text-[#475467] dark:border-[#2a3039] dark:bg-[#161b22] dark:text-[#c5ccd6]">
                Probing browser, simulator, emulator, Redroid, and physical-device render lanes from this machine...
              </div>
            ) : null}
          </section>

          <section className="rounded-md border border-[#d7dce3] bg-white p-3 dark:border-[#2a3039] dark:bg-[#161b22]">
            <SectionLabel>Stack</SectionLabel>
            <ChipRow values={stackLabels.length ? stackLabels : ["unknown"]} />
            <SectionLabel className="mt-3">Platforms</SectionLabel>
            <ChipRow values={surfaceLabels.length ? surfaceLabels : ["render targets not loaded"]} />
            {caps ? (
              <div className="mt-3 text-xs text-[#667085] dark:text-[#9aa3af]">
                {caps.framework} · {caps.executionMode} · {caps.primarySurface} · {caps.currentHostClass || "host unknown"}
                {caps.cached ? " · cached" : caps.probeDurationMs ? ` · probed in ${Math.round(caps.probeDurationMs / 1000)}s` : ""}
              </div>
            ) : null}
          </section>

          <section className="rounded-md border border-[#d7dce3] bg-white p-3 dark:border-[#2a3039] dark:bg-[#161b22]">
            <div className="grid gap-3 md:grid-cols-3">
              <Meta label="Git" value={project?.branch || "unknown"} sub={project?.gitRemote || "remote not detected"} />
              <Meta label="Primary" value={surfaceLabel(project?.primarySurface) || "unknown"} sub={surfaceLabel(project?.executionMode) || "mode not detected"} />
              <Meta label="Role" value={project?.role || "project"} sub={project?.backend || "backend not detected"} />
            </div>
          </section>

          {caps ? (
            <section className="space-y-4">
              {(["browser", "simulator", "container", "device", "advanced", "unavailable"] as const).map((group) => {
                const targets = groupedTargets[group] ?? [];
                if (targets.length === 0) return null;
                return (
                  <div key={group} className="space-y-2">
                    <SectionLabel>{targetGroupLabels[group]}</SectionLabel>
                    <div className="grid gap-2 md:grid-cols-2">
                      {targets.map((target) => (
                        <div key={target.id} className="rounded-md border border-[#d7dce3] bg-white p-3 dark:border-[#2a3039] dark:bg-[#161b22]">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-[#1f2933] dark:text-[#e6e8ec]">{target.label}</div>
                              <div className="mt-1 text-xs text-[#667085] dark:text-[#9aa3af]">{target.surface || "runtime"} · {target.id} · {target.requiredCli || "tools"}</div>
                            </div>
                            <button
                              disabled={!target.enabled || busy !== null}
                              onClick={() => void openRuntimeTarget(target)}
                              aria-label={`${target.enabled ? "Open" : "Unavailable"} ${target.label} (${target.id})`}
                              className="rounded-md bg-[#1f2933] px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-35"
                            >
                              {busy === target.id ? "Opening..." : target.enabled ? "Open" : "Unavailable"}
                            </button>
                          </div>
                          {target.reason ? <div className="mt-2 text-xs text-[#667085] dark:text-[#9aa3af]">{target.reason}</div> : null}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </section>
          ) : null}

          {webPreviewUrl ? (
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <SectionLabel>Web UI</SectionLabel>
                <button onClick={() => setWebPreviewUrl(null)} className="rounded-md border border-[#d7dce3] bg-white px-2 py-1 text-xs text-[#475467] dark:border-[#2a3039] dark:bg-[#161b22] dark:text-[#d7dce3]">Close</button>
              </div>
              <iframe src={webPreviewUrl} title="Project Web UI preview" className="h-[560px] w-full rounded-md border border-[#d7dce3] bg-white dark:border-[#2a3039]" />
            </section>
          ) : null}

          {session ? (
            <section className="space-y-2">
              <SectionLabel>{session.targetLabel || "Remote runtime"}</SectionLabel>
              <RemoteRuntimeViewer session={session} onSessionChange={setSession} />
            </section>
          ) : null}
        </main>

        <aside className="space-y-3">
          <section className="rounded-md border border-[#d7dce3] bg-white p-3 dark:border-[#2a3039] dark:bg-[#161b22]">
            <SectionLabel>Environment</SectionLabel>
            <EnvironmentSwitcher directory={directory} />
          </section>
        </aside>
      </div>
    </div>
  );
}

function SectionLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mb-2 text-[11px] font-semibold uppercase tracking-wide text-[#5d6673] dark:text-[#9aa3af] ${className}`}>{children}</div>;
}

function ChipRow({ values }: { values: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <span key={value} className="rounded-md border border-[#d7dce3] bg-[#f8fafc] px-2 py-1 text-xs font-medium text-[#344054] dark:border-[#2a3039] dark:bg-[#121720] dark:text-[#d7dce3]">{value}</span>
      ))}
    </div>
  );
}

function Meta({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[#667085] dark:text-[#9aa3af]">{label}</div>
      <div className="truncate text-sm font-semibold text-[#1f2933] dark:text-[#e6e8ec]">{value}</div>
      <div className="truncate text-xs text-[#667085] dark:text-[#9aa3af]">{sub}</div>
    </div>
  );
}

function ActionCard({ title, meta, disabled, busy, onClick }: { title: string; meta: string; disabled?: boolean; busy?: boolean; onClick: () => void }) {
  return (
    <button
      disabled={disabled}
      onClick={() => void onClick()}
      aria-label={title}
      className="rounded-md border border-[#d7dce3] bg-white p-3 text-left transition hover:border-[#aeb7c4] hover:bg-[#fbfcfd] disabled:cursor-not-allowed disabled:opacity-45 dark:border-[#2a3039] dark:bg-[#161b22] dark:hover:border-[#3a4350] dark:hover:bg-[#1b222b]"
    >
      <div className="text-sm font-semibold text-[#1f2933] dark:text-[#e6e8ec]">{busy ? "Working..." : title}</div>
      <div className="mt-1 text-xs text-[#667085] dark:text-[#9aa3af]">{meta}</div>
    </button>
  );
}
