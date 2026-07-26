"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  agentClient,
  type RemoteRuntimeCapabilities,
  type RemoteRuntimeSession,
  type RemoteRuntimeTarget,
  type Runner,
  type RunnerBrowserAuthSession,
  type Task,
  type TaskStatus,
  type WorkspaceAppView,
} from "@/lib/agent-client";
import RemoteRuntimeViewer from "./RemoteRuntimeViewer";
import { formatDevProgressLine } from "@/lib/devEventLine";
import { useAuth } from "@/lib/use-auth";
import type { Device } from "@/lib/use-devices";
import { openCodeSnapshotFromConfig, usePrimaryRunnerByDevice } from "./DevicesView";

type Project = {
  name: string;
  path: string;
  framework?: string;
  executionMode?: string;
  frameworks?: string[];
  stack?: string;
  surfaces?: string[];
  tags?: string[];
  monorepoRoot?: string;
  monorepoApp?: string;
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

type MobilePreviewMode = "phone" | "tablet";

const mobilePreviewDevices: Record<MobilePreviewMode, { label: string; width: number; height: number; radius: number }> = {
  phone: { label: "Mobile", width: 393, height: 852, radius: 34 },
  tablet: { label: "Tablet", width: 820, height: 1180, radius: 26 },
};

function RuntimePreviewLoadingScreen({
  note,
  projectName,
}: {
  note?: string | null;
  projectName?: string;
}) {
  return (
    <div className="flex h-full flex-col bg-[#05070a] text-white">
      <div className="flex h-9 items-center justify-between px-5 text-[11px] font-semibold text-white/80">
        <span>9:41</span>
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-4 rounded-full bg-white/70" />
          <span className="h-2.5 w-4 rounded-sm border border-white/70" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
        <div className="flex items-center justify-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl bg-white shadow-2xl shadow-white/10">
            <img src="/icon-192.png" alt="Yaver" className="h-full w-full object-cover" />
          </div>
          <div className="text-4xl font-black tracking-[0.08em] text-white">YAVER</div>
        </div>
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.35em] text-white/55">Remote AI Runtime</div>
          <div className="mt-3 text-xs font-medium text-white/45">{projectName || "Mobile app"}</div>
        </div>
        <div className="mt-2 flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-[12px] text-white/75">
          <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
          <span>{note || "Building web preview..."}</span>
        </div>
      </div>
      <div className="flex justify-center pb-3">
        <div className="h-1 w-28 rounded-full bg-white/35" />
      </div>
    </div>
  );
}

function RuntimePreviewLoadingSurface({
  mobile,
  device,
  note,
  projectName,
}: {
  mobile: boolean;
  device: { label: string; width: number; height: number; radius: number };
  note?: string | null;
  projectName?: string;
}) {
  const body = <RuntimePreviewLoadingScreen note={note} projectName={projectName} />;

  if (!mobile) {
    return (
      <div className="flex h-[520px] w-full items-center justify-center rounded-md border border-[#d7dce3] bg-[#0b0d11] dark:border-[#2a3039]">
        <div className="w-full max-w-sm">{body}</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[640px] w-full justify-center overflow-auto rounded-md border border-[#d7dce3] bg-[#0b0d11] p-4 dark:border-[#2a3039]">
      <div
        className="shrink-0 overflow-hidden bg-[#1f2933] p-[10px] shadow-2xl"
        style={{
          borderRadius: device.radius,
          width: device.width + 20,
          height: device.height + 20,
        }}
      >
        <div
          className="overflow-hidden bg-black"
          style={{
            borderRadius: Math.max(0, device.radius - 10),
            width: device.width,
            height: device.height,
          }}
        >
          {body}
        </div>
      </div>
    </div>
  );
}

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

function projectTerms(project: Project | null): Set<string> {
  const terms = new Set<string>();
  for (const raw of [
    project?.name,
    project?.path,
    project?.framework,
    ...(project?.frameworks ?? []),
    project?.stack,
    ...(project?.surfaces ?? []),
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

function runtimeFrameworkForProject(project: Project | null): string {
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

function isMobileRuntimeProject(project: Project | null): boolean {
  const terms = projectTerms(project);
  return termsContain(terms, [
    "mobile",
    "expo",
    "react-native",
    "react-native-expo",
    "flutter",
    "swift",
    "kotlin",
    "iosnative",
    "androidnative",
  ]);
}

function browserPreviewFrameworkForProject(project: Project | null): string {
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

function isMonorepoProject(project: Project | null): boolean {
  return String(project?.framework || project?.stack || "").trim().toLowerCase() === "monorepo";
}

async function monorepoWebAppName(project: Project | null): Promise<string | undefined> {
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

async function expandMonorepoProjects(rows: Project[]): Promise<Project[]> {
  const expanded: Project[] = [];
  const seen = new Set<string>();
  for (const project of rows) {
    const key = project.path;
    if (key && !seen.has(key)) {
      expanded.push(project);
      seen.add(key);
    }
    if (!isMonorepoProject(project)) continue;
    let apps: WorkspaceAppView[] = [];
    try {
      apps = await agentClient.getWorkspaceApps(["web", "mobile"], project.path);
    } catch {
      continue;
    }
    for (const app of apps) {
      if (!app.exists) continue;
      const appPath = app.absPath || app.path;
      if (!appPath || seen.has(appPath)) continue;
      seen.add(appPath);
      expanded.push({
        name: `${project.name} / ${app.name}`,
        path: appPath,
        framework: app.framework || app.stack || app.kind,
        frameworks: app.framework ? [app.framework] : [],
        stack: app.stack || app.kind,
        surfaces: app.kind ? [app.kind] : undefined,
        tags: [app.kind, app.framework, app.stack, app.name].filter(Boolean) as string[],
        monorepoRoot: project.path,
        monorepoApp: app.name,
      });
    }
  }
  return expanded;
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

function normalizeRunnerId(runnerId?: string | null): string {
  const normalized = String(runnerId || "").trim().toLowerCase();
  if (normalized === "claude-code") return "claude";
  return normalized;
}

function isModelCompatibleWithRunner(modelId: string | null | undefined, runnerId: string | null | undefined): boolean {
  const model = String(modelId || "").trim().toLowerCase();
  const runner = normalizeRunnerId(runnerId);
  if (!model || !runner) return false;
  if (runner === "claude") return model.startsWith("claude-");
  if (runner === "codex") return model.startsWith("gpt-") || model.startsWith("o") || model.includes("codex");
  if (runner === "opencode") {
    const [provider, modelName, ...extra] = model.split("/");
    return Boolean(provider && modelName && extra.length === 0);
  }
  return true;
}

function safeModelForRunner(
  runnerId: string | null | undefined,
  selectedModel: string | null | undefined,
  availableModels: Array<{ id: string; isDefault?: boolean }> | undefined,
): string | undefined {
  const runner = normalizeRunnerId(runnerId);
  if (!runner || runner === "custom") return undefined;
  const selected = String(selectedModel || "").trim();
  if (selected && isModelCompatibleWithRunner(selected, runner) && (availableModels?.length ? availableModels.some((m) => m.id === selected) : true)) {
    return selected;
  }
  const fallback =
    availableModels?.find((model) => model.isDefault && isModelCompatibleWithRunner(model.id, runner))?.id ||
    availableModels?.find((model) => isModelCompatibleWithRunner(model.id, runner))?.id;
  return fallback || undefined;
}

function taskOutputLines(task: Pick<Task, "output" | "resultText" | "status" | "turns"> | null | undefined, fallback: string[] = []): string[] {
  const output = Array.isArray(task?.output)
    ? task.output.flatMap((line) => String(line || "").split(/\r?\n/).map((part) => part.trimEnd()).filter(Boolean))
    : [];
  if (output.length) return output.slice(-240);
  const assistantTurns = Array.isArray(task?.turns)
    ? task.turns
        .filter((turn) => turn?.role === "assistant")
        .flatMap((turn) => String(turn.content || "").split(/\r?\n/).map((part) => part.trimEnd()).filter(Boolean))
    : [];
  if (assistantTurns.length) return assistantTurns.slice(-240);
  const result = String(task?.resultText || "").trim();
  if (result) return result.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).slice(-240);
  if (fallback.length) return fallback.slice(-240);
  const status = task?.status;
  if (status && status !== "queued" && status !== "running") {
    return [`No runner output was captured for this ${status} task.`];
  }
  return [];
}

async function waitForDevPreviewUrl(bundleUrl?: string): Promise<{ url: string; note: string }> {
  const signedUrl = signedBundlePreviewUrl(bundleUrl);
  if (signedUrl) return { url: signedUrl, note: "Web UI bundle ready." };
  let lastError = "";
  // ── The 12-second cliff ────────────────────────────────────────────────────
  // This loop used to run 16 times at 750ms = TWELVE SECONDS, then declare
  // failure. A cold web compile takes 30s–3min: the agent itself allows 120s
  // just for the port to bind, and Expo/Next/Flutter spend longer than that on
  // a first build. So the dashboard reported
  //
  //   web ui failed: Preview URL returned HTTP 503
  //
  // 23 seconds after the click (observed 2026-07-25 on yaver.io) while the dev
  // server was compiling normally and would have served a moment later. The
  // 503 was the agent being HONEST about starting up; the client turned it into
  // a verdict.
  //
  // Two rules this now follows: a transient "still starting" is not a failure,
  // and a wait must say how long it has been waiting (that is why the final
  // message carries elapsed seconds instead of a bare HTTP code).
  const startedAt = Date.now();
  const budgetMs = 180_000;
  for (let i = 0; Date.now() - startedAt < budgetMs; i++) {
    const status = await agentClient.getDevServerStatus();
    if (status?.error) lastError = status.error;
    if (status?.webPort && status.webPort > 0 && agentClient.devWebPreviewUrl) {
      const probed = await probePreviewUrl(agentClient.devWebPreviewUrl);
      if (probed.ok) return { url: agentClient.devWebPreviewUrl, note: status.servingLabel || "Web UI running in this dashboard." };
      lastError = probed.error;
    }
    if ((status?.running || status?.serving || (status?.port ?? 0) > 0) && agentClient.devPreviewUrl) {
      const probed = await probePreviewUrl(agentClient.devPreviewUrl);
      if (probed.ok) return { url: agentClient.devPreviewUrl, note: status?.servingLabel || "Web UI running in this dashboard." };
      lastError = probed.error;
    }
    await sleep(i < 8 ? 750 : 2000);
  }
  const waitedSec = Math.round((Date.now() - startedAt) / 1000);
  throw new Error(
    lastError
      ? `Still no browser preview after ${waitedSec}s — last thing the agent said: ${lastError}. ` +
        `A first web build can take longer than this; the dev server may still be compiling — check the runtime console.`
      : `The agent accepted the Web UI start request, but no browser preview was serving after ${waitedSec}s.`,
  );
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

function targetActionLabel(target: RemoteRuntimeTarget): string {
  return `${target.enabled ? "Open" : "Unavailable"} ${target.label} (${target.id})`;
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
  connectedDevice,
}: {
  intent?: RuntimeLabIntent | null;
  onOpenTmux?: (sessionName: string) => void;
  connectedDevice?: Device | null;
}) {
  const { token } = useAuth();
  const { primaryRunnerByDevice, primaryModelByDevice, opencodeConfigByDevice, setPrimaryRunner, setOpenCodeConfigSnapshot } = usePrimaryRunnerByDevice(token);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [runners, setRunners] = useState<Runner[]>([]);
  const [selectedRunner, setSelectedRunner] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [runnerAuthBusy, setRunnerAuthBusy] = useState(false);
  const [runnerAuthStatus, setRunnerAuthStatus] = useState<RunnerBrowserAuthSession | null>(null);
  const [runnerAuthError, setRunnerAuthError] = useState<string | null>(null);
  const [runnerAuthCallbackUrl, setRunnerAuthCallbackUrl] = useState("");
  const [runnerAuthCallbackBusy, setRunnerAuthCallbackBusy] = useState(false);
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const taskStreamStopRef = useRef<(() => void) | null>(null);
  const taskPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runtimeConsoleRef = useRef<HTMLPreElement | null>(null);
  const taskConsoleRef = useRef<HTMLPreElement | null>(null);
  const [runtimeConsolePinned, setRuntimeConsolePinned] = useState(true);
  const [taskConsolePinned, setTaskConsolePinned] = useState(true);
  const [activeTaskStream, setActiveTaskStream] = useState<{
    id: string;
    title: string;
    status: TaskStatus;
    lines: string[];
  } | null>(null);
  const [caps, setCaps] = useState<RemoteRuntimeCapabilities | null>(null);
  const [session, setSession] = useState<RemoteRuntimeSession | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [devEventsUrl, setDevEventsUrl] = useState<string | null>(() => agentClient.devEventsUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvancedTargets, setShowAdvancedTargets] = useState(false);
  const [webPreviewUrl, setWebPreviewUrl] = useState<string | null>(null);
  const [webPreviewPanelOpen, setWebPreviewPanelOpen] = useState(false);
  const [runtimeControlsOpen, setRuntimeControlsOpen] = useState(false);
  const [vibingSettingsOpen, setVibingSettingsOpen] = useState(false);
  const [webPreviewFrameReady, setWebPreviewFrameReady] = useState(false);
  const [webPreviewBusy, setWebPreviewBusy] = useState(false);
  const [webPreviewNote, setWebPreviewNote] = useState<string | null>(null);
  const [mobilePreviewMode, setMobilePreviewMode] = useState<MobilePreviewMode>("phone");

  const selectedProject = useMemo(
    () => projects.find((p) => p.path === selectedPath) || null,
    [projects, selectedPath],
  );
  const selectedProjectIsMobile = useMemo(() => isMobileRuntimeProject(selectedProject), [selectedProject]);
  const mobilePreviewDevice = mobilePreviewDevices[mobilePreviewMode];

  const appendLog = useCallback((line: string) => {
    const stamp = new Date().toLocaleTimeString();
    setLog((prev) => [...prev.slice(-160), `[${stamp}] ${line}`]);
  }, []);

  const scrollToBottom = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, []);

  const isNearBottom = useCallback((node: HTMLElement) => {
    return node.scrollHeight - node.scrollTop - node.clientHeight < 36;
  }, []);

  useEffect(() => {
    if (runtimeConsolePinned) scrollToBottom(runtimeConsoleRef.current);
  }, [log, runtimeConsolePinned, scrollToBottom]);

  useEffect(() => {
    if (taskConsolePinned) scrollToBottom(taskConsoleRef.current);
  }, [activeTaskStream?.lines, taskConsolePinned, scrollToBottom]);

  useEffect(() => {
    if (selectedProjectIsMobile) setMobilePreviewMode("phone");
  }, [selectedPath, selectedProjectIsMobile]);

  const stopActiveTaskStream = useCallback(() => {
    taskStreamStopRef.current?.();
    taskStreamStopRef.current = null;
    if (taskPollRef.current) clearInterval(taskPollRef.current);
    taskPollRef.current = null;
  }, []);

  useEffect(() => () => stopActiveTaskStream(), [stopActiveTaskStream]);

  const loadProjects = useCallback(async () => {
    setError(null);
    try {
      const [projectRows, repoRows, mobileRows] = await Promise.all([
        agentClient.listProjects(),
        agentClient.listWorkspaceRepos(),
        agentClient.listProjectsByCapability("mobile").catch(() => []),
      ]);
      const rows = await expandMonorepoProjects(mergeProjectInventory([...(projectRows as Project[]), ...(mobileRows as Project[])], repoRows));
      setProjects(rows);
      if (!selectedPath && rows[0]?.path) setSelectedPath(rows[0].path);
      appendLog(`projects loaded: ${rows.length}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load projects.");
    }
  }, [appendLog, selectedPath]);

  const refreshRunners = useCallback(async () => {
    try {
      const rows = (await agentClient.getRunners()).filter((runner) => {
        if (!runner.installed) return false;
        const id = String(runner.id || "").toLowerCase();
        return !id.includes("aider") && !id.includes("ollama");
      });
      setRunners(rows);
      const explicitRunner = connectedDevice?.id ? primaryRunnerByDevice[connectedDevice.id] : "";
      const preferred =
        rows.find((runner) => runner.id === explicitRunner) ||
        rows.find((runner) => runner.active) ||
        rows.find((runner) => runner.isDefault) ||
        rows.find((runner) => runner.ready) ||
        rows[0];
      if (preferred && (!selectedRunner || !rows.some((runner) => runner.id === selectedRunner))) {
        setSelectedRunner(preferred.id);
      }
    } catch {
      setRunners([]);
    }
  }, [connectedDevice?.id, primaryRunnerByDevice, selectedRunner]);

  useEffect(() => {
    void refreshRunners();
    const id = window.setInterval(() => void refreshRunners(), 5000);
    return () => window.clearInterval(id);
  }, [refreshRunners]);

  const selectedRunnerRow = useMemo(
    () => runners.find((runner) => runner.id === selectedRunner) || null,
    [runners, selectedRunner],
  );
  const opencodeSnapshot = connectedDevice?.id ? opencodeConfigByDevice[connectedDevice.id] : undefined;
  const availableModels = useMemo(() => {
    if (normalizeRunnerId(selectedRunner) === "opencode" && opencodeSnapshot?.models?.length) {
      return opencodeSnapshot.models.map((model) => ({
        id: model.id,
        name: model.name || model.id,
        provider: model.provider,
        isDefault: model.isDefault,
        source: model.source || "opencode-config",
      }));
    }
    return selectedRunnerRow?.models || [];
  }, [opencodeSnapshot?.models, selectedRunner, selectedRunnerRow?.models]);
  const effectiveChatModel = safeModelForRunner(selectedRunner, selectedModel, availableModels) || selectedModel;
  const selectedRunnerName = selectedRunnerRow?.name || selectedRunner || "Runner";
  const chatStatusTone = activeTaskStream?.status === "failed"
    ? "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-200"
    : activeTaskStream?.status === "completed"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
      : activeTaskStream
        ? "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200"
        : "border-[#d7dce3] bg-[#f2f4f7] text-[#667085] dark:border-[#2a3039] dark:bg-[#101318] dark:text-[#9aa3af]";

  useEffect(() => {
    if (!connectedDevice?.id || normalizeRunnerId(selectedRunner) !== "opencode") return;
    let cancelled = false;
    void agentClient.openCodeConfig(connectedDevice.id).then((cfg) => {
      if (cancelled) return;
      const snapshot = openCodeSnapshotFromConfig(connectedDevice.id, cfg);
      if (!snapshot.model && !snapshot.provider && !snapshot.models?.length && !snapshot.providers?.length) return;
      void setOpenCodeConfigSnapshot(snapshot).catch(() => {});
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [connectedDevice?.id, selectedRunner, setOpenCodeConfigSnapshot]);

  useEffect(() => {
    const explicitModel = connectedDevice?.id ? primaryModelByDevice[connectedDevice.id] || opencodeSnapshot?.model || "" : "";
    if (explicitModel && availableModels.some((model) => model.id === explicitModel)) {
      setSelectedModel(explicitModel);
    } else if (!selectedModel || !availableModels.some((model) => model.id === selectedModel)) {
      setSelectedModel(availableModels.find((model) => model.isDefault)?.id || availableModels[0]?.id || "");
    }
  }, [availableModels, connectedDevice?.id, opencodeSnapshot?.model, primaryModelByDevice, selectedModel]);

  useEffect(() => {
    if (!runnerAuthStatus?.id || ["completed", "failed", "cancelled", "account_not_eligible"].includes(runnerAuthStatus.status)) return;
    const id = window.setInterval(async () => {
      try {
        const next = await agentClient.getRunnerBrowserAuthStatus(runnerAuthStatus.id);
        setRunnerAuthStatus(next);
        if (["completed", "failed", "cancelled", "account_not_eligible"].includes(next.status)) {
          setRunnerAuthBusy(false);
          void refreshRunners();
        }
      } catch (err) {
        setRunnerAuthError(err instanceof Error ? err.message : String(err));
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [refreshRunners, runnerAuthStatus?.id, runnerAuthStatus?.status]);

  useEffect(() => {
    const unsubscribe = agentClient.on("connectionState", () => setDevEventsUrl(agentClient.devEventsUrl));
    setDevEventsUrl(agentClient.devEventsUrl);
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!devEventsUrl) return;
    const es = new EventSource(devEventsUrl);
    es.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data);
        if (ev.type === "log" && typeof ev.message === "string") appendLog(`dev: ${ev.message}`);
        else if (ev.type === "phase" && ev.topic && ev.phase) appendLog(`${ev.topic}: ${ev.phase}`);
        // Agent pct is already 0..100 (devserver.go Pct) — multiplying by
        // 100 here printed "1575% streaming". formatDevProgressLine clamps.
        else if (ev.type === "progress" && ev.topic) appendLog(formatDevProgressLine(ev.topic, ev.pct, ev.phase));
        else if (ev.type === "ready") appendLog("dev server ready");
        else if (ev.type === "error" && ev.error) appendLog(`dev error: ${ev.error}`);
        else if (ev.type === "snapshot" && ev.snapshot?.recentLogs?.length) {
          for (const line of ev.snapshot.recentLogs.slice(-3)) appendLog(`dev: ${line}`);
        }
      } catch {
        if (msg.data) appendLog(`dev: ${String(msg.data).slice(0, 240)}`);
      }
    };
    es.onerror = () => appendLog("dev events stream interrupted");
    return () => es.close();
  }, [appendLog, devEventsUrl]);

  const startSelectedRunnerSignIn = useCallback(async () => {
    if (!selectedRunnerRow || !["claude", "codex"].includes(selectedRunnerRow.id)) return;
    setRunnerAuthBusy(true);
    setRunnerAuthError(null);
    setRunnerAuthCallbackUrl("");
    try {
      const session = await agentClient.startRunnerBrowserAuth(selectedRunnerRow.id);
      setRunnerAuthStatus(session);
      if (session.openUrl) window.open(session.openUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      setRunnerAuthBusy(false);
      setRunnerAuthError(err instanceof Error ? err.message : String(err));
    }
  }, [selectedRunnerRow]);

  const submitRunnerAuthCallback = useCallback(async () => {
    const callbackUrl = runnerAuthCallbackUrl.trim();
    if (!runnerAuthStatus?.id || !callbackUrl || runnerAuthCallbackBusy) return;
    setRunnerAuthCallbackBusy(true);
    setRunnerAuthError(null);
    try {
      const next = await agentClient.submitRunnerBrowserAuthCallback(runnerAuthStatus.id, callbackUrl);
      setRunnerAuthStatus(next);
      setRunnerAuthCallbackUrl("");
      appendLog(`runner oauth callback delivered: ${runnerAuthStatus.runner}`);
    } catch (err) {
      setRunnerAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunnerAuthCallbackBusy(false);
    }
  }, [appendLog, runnerAuthCallbackBusy, runnerAuthCallbackUrl, runnerAuthStatus?.id, runnerAuthStatus?.runner]);

  const saveRunnerChoice = useCallback(async () => {
    if (!connectedDevice?.id || !selectedRunner) return;
    const provider = normalizeRunnerId(selectedRunner) === "opencode" && selectedModel.includes("/")
      ? selectedModel.split("/")[0]
      : null;
    await setPrimaryRunner(connectedDevice.id, selectedRunner, selectedModel || null, undefined, provider);
    appendLog(`runner set: ${selectedRunner}${selectedModel ? ` ${selectedModel}` : ""}`);
  }, [appendLog, connectedDevice?.id, selectedModel, selectedRunner, setPrimaryRunner]);

  const sendPrompt = useCallback(async () => {
    const prompt = composer.trim();
    if (!prompt || sending) return;
    setSending(true);
    try {
      stopActiveTaskStream();
      const effectiveModel = safeModelForRunner(selectedRunner, selectedModel, availableModels);
      if (selectedModel && selectedRunner && effectiveModel !== selectedModel) {
        appendLog(`model corrected for ${selectedRunner}: ${selectedModel} -> ${effectiveModel || "runner default"}`);
      }
      const task = await agentClient.createTask({
        title: prompt.slice(0, 80),
        description: prompt,
        runner: selectedRunner || undefined,
        model: effectiveModel,
        projectName: selectedProject?.name,
        workDir: selectedProject?.path,
      });
      setActiveTaskStream({ id: task.id, title: task.title, status: task.status, lines: taskOutputLines(task) });
      appendLog(`task ${task.id} started with ${selectedRunner || "default runner"}${effectiveModel ? ` ${effectiveModel}` : ""}`);
      taskStreamStopRef.current = agentClient.streamTaskOutput(task.id, (line) => {
        const trimmed = String(line || "").trimEnd();
        if (!trimmed) return;
        setActiveTaskStream((prev) => {
          if (!prev || prev.id !== task.id) return prev;
          const lines = [...prev.lines, trimmed];
          return { ...prev, status: "running", lines: lines.slice(-240) };
        });
      });
      taskPollRef.current = setInterval(() => {
        void agentClient.getTask(task.id).then((fresh) => {
          setActiveTaskStream((prev) => {
            if (!prev || prev.id !== task.id) return prev;
            const lines = taskOutputLines(fresh, prev.lines);
            return { ...prev, status: fresh.status, lines };
          });
          if (fresh.status !== "queued" && fresh.status !== "running") stopActiveTaskStream();
        }).catch(() => {});
      }, 2000);
      setComposer("");
    } catch (err) {
      appendLog(`task failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSending(false);
    }
  }, [appendLog, availableModels, composer, selectedModel, selectedProject, selectedRunner, sending, stopActiveTaskStream]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const loadCapabilities = useCallback(async (project: Project | null = selectedProject) => {
    if (!project) return;
    setBusy(true);
    setError(null);
    setCaps(null);
    setSession(null);
    const runtimeFramework = runtimeFrameworkForProject(project);
    appendLog(`probing render targets for ${project.name} ${runtimeFramework || "unknown"}`);
    try {
      const next = await agentClient.getRemoteRuntimeCapabilities(project.path, runtimeFramework);
      next.targets = [...(next.targets || [])].sort(targetSort);
      setCaps(next);
      const primaryCount = next.targets.filter(isPrimaryRuntimeTarget).length;
      appendLog(`targets: ${primaryCount} primary, ${Math.max(0, next.targets.length - primaryCount)} advanced/unavailable${next.cached ? " (cached)" : ""}`);
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
        runtimeFrameworkForProject(selectedProject),
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
    setWebPreviewPanelOpen(true);
    setRuntimeControlsOpen(false);
    setWebPreviewUrl(null);
    setWebPreviewFrameReady(false);
    setWebPreviewBusy(true);
    setWebPreviewNote(null);
    setError(null);
    appendLog(`web ui ${selectedProject.name}`);
    try {
      const framework = browserPreviewFrameworkForProject(selectedProject);
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
      const app = await monorepoWebAppName(selectedProject);
      const response = await agentClient.startDevServer(app ? {
        app,
        root: selectedProject.path,
        platform: "web",
        surface: "web-reload",
      } : {
        framework,
        workDir: selectedProject.path,
        platform: "web",
        surface: "web-reload",
      });
      if (response.mode === "static-bundle") {
        const existingSignedUrl = signedBundlePreviewUrl(response.bundleUrl);
        if (response.bundleReady && existingSignedUrl) {
          setWebPreviewUrl(existingSignedUrl);
          setWebPreviewNote(response.bundleHint || "Web UI bundle ready.");
          appendLog(`web ui ready ${existingSignedUrl}`);
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
      const preview = await waitForDevPreviewUrl(response.bundleUrl);
      setWebPreviewUrl(preview.url);
      setWebPreviewNote(response.bundleHint || preview.note);
      appendLog(`web ui ready ${preview.url}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not open Web UI.";
      setWebPreviewNote(message);
      setError(message);
      appendLog(`web ui failed: ${message}`);
    } finally {
      setWebPreviewBusy(false);
    }
  }, [appendLog, selectedProject]);

  const closeWebPreview = useCallback(() => {
    setWebPreviewPanelOpen(false);
    setRuntimeControlsOpen(false);
    setWebPreviewUrl(null);
    setWebPreviewFrameReady(false);
    setWebPreviewNote(null);
  }, []);

  useEffect(() => {
    if (!webPreviewUrl) {
      setWebPreviewFrameReady(false);
      return;
    }
    setWebPreviewFrameReady(false);
  }, [webPreviewUrl]);

  useEffect(() => {
    if (!intent || intent.kind !== "runtime" || projects.length === 0) return;
    const project = projects.find((p) => projectMatches(p, intent.projectQuery)) || projects[0];
    setSelectedPath(project.path);
    void (async () => {
      await loadCapabilities(project);
      const wanted = targetIdFor(intent.surface, intent.platform);
      if (!wanted) return;
      const nextCaps = await agentClient.getRemoteRuntimeCapabilities(project.path, runtimeFrameworkForProject(project));
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
    <div className="grid h-full min-h-0 gap-3 bg-[#f2f4f7] p-3 text-[#1f2933] dark:bg-[#101318] dark:text-[#e6e8ec] sm:p-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="min-h-0 space-y-3 overflow-y-auto">
        {!webPreviewPanelOpen ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[260px] flex-1">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-[#5d6673] dark:text-[#9aa3af]">Project</span>
            <select
              value={selectedPath}
              onChange={(e) => { setSelectedPath(e.target.value); setCaps(null); setSession(null); setWebPreviewPanelOpen(false); setRuntimeControlsOpen(false); setWebPreviewUrl(null); setWebPreviewNote(null); }}
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
            {busy ? "Loading targets..." : "Load Targets"}
          </button>
        </div>
        ) : null}

        {error ? (
          <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-700 dark:text-rose-200">{error}</div>
        ) : null}

        {caps ? (
          <div className="space-y-3">
            <div className="text-xs text-[#667085] dark:text-[#9aa3af]">
              {caps.framework} · {caps.executionMode} · {caps.primarySurface} · {caps.currentHostClass || "host unknown"}
              {caps.cached ? " · cached" : caps.probeDurationMs ? ` · probed in ${Math.round(caps.probeDurationMs / 1000)}s` : ""}
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
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className={`text-sm font-medium ${target.enabled ? "text-[#1f2933] dark:text-[#e6e8ec]" : "text-[#667085] dark:text-[#8b949e]"}`}>{target.label}</div>
                      <div className="mt-1 text-xs text-[#667085] dark:text-[#9aa3af]">
                        {target.surface || "runtime"} · {target.id} · {target.requiredCli || "tools"}
                      </div>
                    </div>
                    <button
                      disabled={!target.enabled || busy}
                      onClick={() => void createSession(target.id)}
                      aria-label={targetActionLabel(target)}
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
                  {!webPreviewPanelOpen ? (
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
                            aria-label="Open Web UI in browser"
                            className="rounded-md bg-sky-500/15 px-3 py-1.5 text-xs font-semibold text-sky-700 disabled:cursor-not-allowed disabled:opacity-40 dark:text-sky-200"
                          >
                            {webPreviewBusy ? "Building..." : "Open"}
                          </button>
                        </div>
                        {webPreviewNote ? <div className="mt-2 text-xs text-[#667085] dark:text-[#9aa3af]">{webPreviewNote}</div> : null}
                      </div>
                      {(groupedTargets.browser ?? []).map((target) => renderTarget(target))}
                    </div>
                  </section>
                  ) : null}
                  {webPreviewPanelOpen ? (
                    <section className="space-y-2">
                      <div className="flex items-center justify-between gap-3 rounded-md border border-[#d7dce3] bg-white px-3 py-2 dark:border-[#2a3039] dark:bg-[#161b22]">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <img src="/icon-192.png" alt="Yaver" className="h-6 w-6 rounded-md" />
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-[#1f2933] dark:text-[#e6e8ec]">
                              {selectedProject?.name || "Preview"}
                            </div>
                            <div className="truncate text-[11px] text-[#667085] dark:text-[#9aa3af]">
                              {webPreviewNote || (webPreviewBusy ? "Building web preview..." : selectedProjectIsMobile ? "Mobile Web UI" : "Web UI")}
                            </div>
                          </div>
                          {selectedProjectIsMobile ? (
                            <div className="inline-flex rounded-md border border-[#d7dce3] bg-white p-0.5 dark:border-[#2a3039] dark:bg-[#161b22]">
                              {(Object.keys(mobilePreviewDevices) as MobilePreviewMode[]).map((mode) => {
                                const device = mobilePreviewDevices[mode];
                                const selected = mobilePreviewMode === mode;
                                return (
                                  <button
                                    key={mode}
                                    type="button"
                                    onClick={() => setMobilePreviewMode(mode)}
                                    className={`rounded px-2 py-1 text-[11px] font-medium ${
                                      selected
                                        ? "bg-[#1f2933] text-white dark:bg-[#e6e8ec] dark:text-[#101318]"
                                        : "text-[#667085] hover:text-[#1f2933] dark:text-[#9aa3af] dark:hover:text-[#e6e8ec]"
                                    }`}
                                  >
                                    {device.label}
                                  </button>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setRuntimeControlsOpen((v) => !v)}
                            title="Preview controls"
                            aria-label="Preview controls"
                            className={`rounded-md border p-1.5 ${
                              runtimeControlsOpen
                                ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-200"
                                : "border-[#d7dce3] bg-white text-[#475467] hover:text-[#1f2933] dark:border-[#2a3039] dark:bg-[#101318] dark:text-[#d7dce3]"
                            }`}
                          >
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <line x1="4" y1="21" x2="4" y2="14" />
                              <line x1="4" y1="10" x2="4" y2="3" />
                              <line x1="12" y1="21" x2="12" y2="12" />
                              <line x1="12" y1="8" x2="12" y2="3" />
                              <line x1="20" y1="21" x2="20" y2="16" />
                              <line x1="20" y1="12" x2="20" y2="3" />
                              <line x1="2" y1="14" x2="6" y2="14" />
                              <line x1="10" y1="8" x2="14" y2="8" />
                              <line x1="18" y1="16" x2="22" y2="16" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            onClick={() => void openWebUI()}
                            disabled={webPreviewBusy}
                            title="Rebuild preview"
                            aria-label="Rebuild preview"
                            className="rounded-md border border-[#d7dce3] bg-white p-1.5 text-[#475467] hover:text-[#1f2933] disabled:opacity-40 dark:border-[#2a3039] dark:bg-[#101318] dark:text-[#d7dce3]"
                          >
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M21 12a9 9 0 0 1-15.1 6.6" />
                              <path d="M3 12A9 9 0 0 1 18.1 5.4" />
                              <path d="M3 19v-6h6" />
                              <path d="M21 5v6h-6" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            onClick={closeWebPreview}
                            title="Close preview"
                            aria-label="Close preview"
                            className="rounded-md border border-[#d7dce3] bg-white p-1.5 text-[#475467] hover:text-[#1f2933] dark:border-[#2a3039] dark:bg-[#101318] dark:text-[#d7dce3]"
                          >
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </div>
                      </div>
                      {!webPreviewUrl ? (
                        <RuntimePreviewLoadingSurface
                          mobile={selectedProjectIsMobile}
                          device={mobilePreviewDevice}
                          note={webPreviewNote}
                          projectName={selectedProject?.name}
                        />
                      ) : selectedProjectIsMobile ? (
                        <div className="flex min-h-[640px] w-full justify-center overflow-auto rounded-md border border-[#d7dce3] bg-[#0b0d11] p-4 dark:border-[#2a3039]">
                          <div
                            className="shrink-0 overflow-hidden bg-[#1f2933] p-[10px] shadow-2xl"
                            style={{
                              borderRadius: mobilePreviewDevice.radius,
                              width: mobilePreviewDevice.width + 20,
                              height: mobilePreviewDevice.height + 20,
                            }}
                          >
                            <div
                              className="relative overflow-hidden bg-black"
                              style={{
                                borderRadius: Math.max(0, mobilePreviewDevice.radius - 10),
                                width: mobilePreviewDevice.width,
                                height: mobilePreviewDevice.height,
                              }}
                            >
                              <iframe
                                src={webPreviewUrl}
                                width={mobilePreviewDevice.width}
                                height={mobilePreviewDevice.height}
                                className="border-none bg-white"
                                title={`${mobilePreviewDevice.label} Web UI preview`}
                                onLoad={() => window.setTimeout(() => setWebPreviewFrameReady(true), 900)}
                              />
                              {!webPreviewFrameReady ? (
                                <div className="absolute inset-0">
                                  <RuntimePreviewLoadingScreen
                                    note={webPreviewNote || "Starting mobile web preview..."}
                                    projectName={selectedProject?.name}
                                  />
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="relative h-[520px] w-full overflow-hidden rounded-md border border-[#d7dce3] bg-[#0b0d11]">
                          <iframe
                            src={webPreviewUrl}
                            className="h-full w-full border-none bg-white"
                            title="Project Web UI preview"
                            onLoad={() => window.setTimeout(() => setWebPreviewFrameReady(true), 900)}
                          />
                          {!webPreviewFrameReady ? (
                            <div className="absolute inset-0">
                              <RuntimePreviewLoadingScreen
                                note={webPreviewNote || "Starting web preview..."}
                                projectName={selectedProject?.name}
                              />
                            </div>
                          ) : null}
                        </div>
                      )}
                    </section>
                  ) : null}
                  {!webPreviewPanelOpen || runtimeControlsOpen ? (
                  <>
                  {webPreviewPanelOpen ? (
                    <div className="rounded-md border border-[#d7dce3] bg-white p-3 dark:border-[#2a3039] dark:bg-[#161b22]">
                      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[#5d6673] dark:text-[#9aa3af]">Project</div>
                      <div className="flex flex-wrap items-end gap-2">
                        <label className="min-w-[260px] flex-1">
                          <select
                            value={selectedPath}
                            onChange={(e) => { setSelectedPath(e.target.value); setCaps(null); setSession(null); setWebPreviewPanelOpen(false); setRuntimeControlsOpen(false); setWebPreviewUrl(null); setWebPreviewNote(null); }}
                            className="w-full rounded-md border border-[#d7dce3] bg-white px-3 py-2 text-sm text-[#1f2933] dark:border-[#2a3039] dark:bg-[#101318] dark:text-[#e6e8ec]"
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
                          {busy ? "Loading..." : "Load Targets"}
                        </button>
                      </div>
                    </div>
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
                  ) : null}
                </>
              );
            })()}
          </div>
        ) : (
          <div className="rounded-md border border-[#d7dce3] bg-white p-4 text-sm text-[#667085] dark:border-[#2a3039] dark:bg-[#161b22] dark:text-[#9aa3af]">
            {busy ? "Probing browser, simulator, emulator, Redroid, and physical-device render lanes from this machine..." : "Load targets to boot watchOS, Wear OS, TV, phone, browser, and other runtime surfaces from this machine."}
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

      <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto border-t border-[#d7dce3] pt-3 dark:border-[#2a3039] xl:border-l xl:border-t-0 xl:pl-3 xl:pt-0">
        <div className="flex min-h-[420px] flex-1 flex-col overflow-hidden rounded-md border border-[#d7dce3] bg-white shadow-sm dark:border-[#2a3039] dark:bg-[#141820]">
          <div className="border-b border-[#e4e7ec] px-4 py-3 dark:border-[#242b35]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-[#5d6673] dark:text-[#9aa3af]">Chat</div>
                <div className="mt-1 min-w-0 truncate text-sm font-semibold text-[#1f2933] dark:text-[#e6e8ec]">
                  {selectedProject?.name || "No project selected"}
                </div>
              </div>
              <span className={`shrink-0 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${chatStatusTone}`}>
                {activeTaskStream?.status || "Ready"}
              </span>
            </div>
            <div className="mt-3 flex min-w-0 flex-wrap gap-1.5 text-[11px] text-[#667085] dark:text-[#9aa3af]">
              <span className="rounded-full border border-[#d7dce3] bg-[#f8fafc] px-2 py-1 dark:border-[#2a3039] dark:bg-[#101318]">
                {selectedRunnerName}
              </span>
              <span className="min-w-0 max-w-full truncate rounded-full border border-[#d7dce3] bg-[#f8fafc] px-2 py-1 font-mono dark:border-[#2a3039] dark:bg-[#101318]">
                {effectiveChatModel || "runner default"}
              </span>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col bg-[#f8fafc] dark:bg-[#0f1218]">
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {activeTaskStream ? (
                <div className="space-y-3">
                  <div className="flex justify-end">
                    <div className="max-w-[88%] rounded-2xl rounded-br-md bg-[#7c5cff] px-3 py-2 text-sm leading-5 text-white shadow-sm">
                      {activeTaskStream.title}
                    </div>
                  </div>
                  <div className="rounded-2xl rounded-bl-md border border-[#e4e7ec] bg-white shadow-sm dark:border-[#242b35] dark:bg-[#171b23]">
                    <div className="flex items-center justify-between gap-2 border-b border-[#eef1f5] px-3 py-2 dark:border-[#242b35]">
                      <div className="min-w-0 truncate text-xs font-semibold text-[#344054] dark:text-[#d7dce3]">
                        {selectedRunnerName}
                      </div>
                      <div className="shrink-0 text-[10px] uppercase tracking-wide text-[#667085] dark:text-[#9aa3af]">
                        {activeTaskStream.status}
                      </div>
                    </div>
                    <pre
                      ref={taskConsoleRef}
                      onScroll={(event) => setTaskConsolePinned(isNearBottom(event.currentTarget))}
                      className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words p-3 text-[11px] leading-5 text-[#344054] dark:text-[#d5dae1]"
                    >
                      {activeTaskStream.lines.length ? activeTaskStream.lines.join("\n") : "Waiting for runner output..."}
                    </pre>
                  </div>
                  {!taskConsolePinned ? (
                    <button
                      type="button"
                      onClick={() => {
                        setTaskConsolePinned(true);
                        scrollToBottom(taskConsoleRef.current);
                      }}
                      className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-[10px] font-semibold text-sky-700 dark:text-sky-300"
                    >
                      Follow output
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="flex h-full min-h-[220px] items-center justify-center">
                  <div className="max-w-[260px] text-center">
                    <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-[#d7dce3] bg-white text-sm font-black text-[#1f2933] shadow-sm dark:border-[#2a3039] dark:bg-[#171b23] dark:text-[#e6e8ec]">
                      Y
                    </div>
                    <div className="mt-3 text-sm font-semibold text-[#344054] dark:text-[#d7dce3]">
                      Ready for {selectedProject?.name || "a project"}
                    </div>
                    <div className="mt-1 text-xs leading-5 text-[#667085] dark:text-[#9aa3af]">
                      {selectedRunner ? `${selectedRunnerName} will run the next task.` : "Select a runner below."}
                    </div>
                  </div>
                </div>
              )}
              </div>
            <div className="border-t border-[#e4e7ec] bg-white p-3 dark:border-[#242b35] dark:bg-[#141820]">
              <div className="flex items-end gap-2 rounded-md border border-[#d7dce3] bg-[#f8fafc] p-2 focus-within:border-[#98a2b3] dark:border-[#2a3039] dark:bg-[#101318]">
                <textarea
                  value={composer}
                  onChange={(event) => setComposer(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendPrompt();
                    }
                  }}
                  rows={3}
                  placeholder={selectedProject ? `Ask ${selectedRunner || "the runner"} to change ${selectedProject.name}` : "Pick a project first"}
                  className="max-h-40 min-h-[76px] flex-1 resize-none border-0 bg-transparent px-1 py-1 text-sm leading-5 text-[#1f2933] outline-none placeholder:text-[#98a2b3] dark:text-[#e6e8ec] dark:placeholder:text-[#667085]"
                />
                <button
                  disabled={!composer.trim() || sending}
                  onClick={() => void sendPrompt()}
                  className="h-10 shrink-0 rounded-md bg-[#7c5cff] px-4 text-xs font-semibold text-white shadow-sm disabled:cursor-not-allowed disabled:bg-[#d7dce3] disabled:text-[#98a2b3] dark:disabled:bg-[#242b35]"
                >
                  {sending ? "Sending" : "Send"}
                </button>
              </div>
            </div>
          </div>
        </div>
        <div className="rounded-md border border-[#d7dce3] bg-white p-3 dark:border-[#2a3039] dark:bg-[#141820]">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-[#5d6673] dark:text-[#9aa3af]">Runtime Console</div>
              <div className="mt-0.5 text-[11px] text-[#667085] dark:text-[#9aa3af]">{log.length} events</div>
            </div>
            {!runtimeConsolePinned ? (
              <button
                type="button"
                onClick={() => {
                  setRuntimeConsolePinned(true);
                  scrollToBottom(runtimeConsoleRef.current);
                }}
                className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-[10px] font-semibold text-sky-700 dark:text-sky-300"
              >
                Follow logs
              </button>
            ) : null}
          </div>
          <pre
            ref={runtimeConsoleRef}
            onScroll={(event) => setRuntimeConsolePinned(isNearBottom(event.currentTarget))}
            className="h-52 overflow-auto rounded-md border border-[#1f2933] bg-[#0b0d11] p-3 text-[11px] leading-5 text-[#d5dae1]"
          >
            {log.length ? log.join("\n") : "No runtime operations yet."}
          </pre>
        </div>
        <div className="rounded-md border border-[#d7dce3] bg-white p-3 dark:border-[#2a3039] dark:bg-[#161b22]">
          <button
            type="button"
            onClick={() => setVibingSettingsOpen((open) => !open)}
            className="flex w-full items-center justify-between gap-3 text-left"
            aria-expanded={vibingSettingsOpen}
          >
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-[#5d6673] dark:text-[#9aa3af]">Vibing</div>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[#475467] dark:text-[#d7dce3]">
                <span><span className="font-semibold text-[#1f2933] dark:text-[#e6e8ec]">Runner</span> {selectedRunnerRow?.name || selectedRunner || "none"}</span>
                <span className="text-[#98a2b3]">/</span>
                <span className="min-w-0 truncate"><span className="font-semibold text-[#1f2933] dark:text-[#e6e8ec]">Model</span> {safeModelForRunner(selectedRunner, selectedModel, availableModels) || selectedModel || "runner default"}</span>
              </div>
            </div>
            <span className="shrink-0 text-xs font-semibold text-sky-700 dark:text-sky-300">
              {vibingSettingsOpen ? "Hide" : "Settings"}
            </span>
          </button>
          {vibingSettingsOpen || runnerAuthStatus || runnerAuthError ? (
            <div className="mt-3 grid gap-2">
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[#667085] dark:text-[#9aa3af]">Runner</span>
                <select
                  value={selectedRunner}
                  onChange={(event) => setSelectedRunner(event.target.value)}
                  className="w-full rounded-md border border-[#d7dce3] bg-white px-2 py-1.5 text-xs text-[#1f2933] dark:border-[#2a3039] dark:bg-[#101318] dark:text-[#e6e8ec]"
                >
                  {runners.length === 0 ? <option value="">No runners detected</option> : null}
                  {runners.map((runner) => (
                    <option key={runner.id} value={runner.id}>
                      {runner.name}{runner.ready === false ? " (sign-in needed)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              {availableModels.length > 0 ? (
                <label className="block">
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[#667085] dark:text-[#9aa3af]">Model</span>
                  <select
                    value={selectedModel}
                    onChange={(event) => setSelectedModel(event.target.value)}
                    className="w-full rounded-md border border-[#d7dce3] bg-white px-2 py-1.5 text-xs text-[#1f2933] dark:border-[#2a3039] dark:bg-[#101318] dark:text-[#e6e8ec]"
                  >
                    {availableModels.map((model) => (
                      <option key={model.id} value={model.id}>{model.name || model.id}</option>
                    ))}
                  </select>
                  {normalizeRunnerId(selectedRunner) === "opencode" ? (
                    <div className="mt-2 rounded-md border border-cyan-500/20 bg-cyan-500/5 p-2 text-[10px] text-[#475467] dark:text-[#c7d2e1]">
                      <div className="font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-200">OpenCode config</div>
                      <div className="mt-1 grid gap-1">
                        <div>Provider: <span className="font-mono">{safeModelForRunner(selectedRunner, selectedModel, availableModels)?.split("/")[0] || opencodeSnapshot?.provider || "from opencode default"}</span></div>
                        <div>Model: <span className="font-mono">{safeModelForRunner(selectedRunner, selectedModel, availableModels) || opencodeSnapshot?.model || "from opencode default"}</span></div>
                        <div>Agent: <span className="font-mono">{opencodeSnapshot?.defaultAgent || "build"}</span></div>
                        {opencodeSnapshot?.buildModel ? <div>Build model: <span className="font-mono">{opencodeSnapshot.buildModel}</span></div> : null}
                        {opencodeSnapshot?.planModel ? <div>Plan model: <span className="font-mono">{opencodeSnapshot.planModel}</span></div> : null}
                        {opencodeSnapshot?.providers?.length ? (
                          <div>
                            Auth: {opencodeSnapshot.providers.map((provider) => `${provider.id}${provider.hasApiKey ? " key" : ""}`).join(", ")}
                          </div>
                        ) : null}
                        {opencodeSnapshot?.updatedAt ? (
                          <div>Snapshot: {new Date(opencodeSnapshot.updatedAt).toLocaleTimeString()}</div>
                        ) : null}
                      </div>
                      {opencodeSnapshot?.diagnostics?.length ? (
                        <div className="mt-2 text-amber-700 dark:text-amber-200">
                          {opencodeSnapshot.diagnostics.join(" ")}
                        </div>
                      ) : null}
                      <div className="mt-2 text-[#667085] dark:text-[#9aa3af]">
                        OpenCode uses provider/model IDs such as zai-coding-plan/glm-4.7. Unqualified Codex models are blocked before send.
                      </div>
                    </div>
                  ) : null}
                </label>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button
                  disabled={!connectedDevice?.id || !selectedRunner}
                  onClick={() => void saveRunnerChoice()}
                  className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-semibold text-emerald-700 disabled:opacity-40 dark:text-emerald-200"
                >
                  Save for machine
                </button>
                {selectedRunnerRow?.supportsBrowserAuth && selectedRunnerRow.ready === false ? (
                  <button
                    disabled={runnerAuthBusy}
                    onClick={() => void startSelectedRunnerSignIn()}
                    className="rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-[11px] font-semibold text-sky-700 disabled:opacity-40 dark:text-sky-200"
                  >
                    {runnerAuthBusy ? "Opening..." : "Remote OAuth"}
                  </button>
                ) : null}
              </div>
              {runnerAuthStatus ? (
                <div className="rounded-md border border-[#d7dce3] bg-[#f8fafc] p-2 text-[11px] text-[#475467] dark:border-[#2a3039] dark:bg-[#101318] dark:text-[#d7dce3]">
                  <div className="font-semibold uppercase tracking-wide text-[#667085] dark:text-[#9aa3af]">OAuth status</div>
                  <div className="mt-1">{runnerAuthStatus.status.replaceAll("_", " ")}</div>
                  {runnerAuthStatus.callbackPort ? (
                    <div className="mt-1 text-[#667085] dark:text-[#9aa3af]">
                      Waiting on localhost:{runnerAuthStatus.callbackPort}. If the auth tab ends on a localhost callback page, paste its address below.
                    </div>
                  ) : null}
                  {runnerAuthStatus.code ? <div className="mt-1 font-mono">Code: {runnerAuthStatus.code}</div> : null}
                  {runnerAuthStatus.openUrl ? (
                    <a href={runnerAuthStatus.openUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-sky-700 underline dark:text-sky-300">
                      Open auth page
                    </a>
                  ) : null}
                  {runnerAuthStatus.detail ? <div className="mt-1">{runnerAuthStatus.detail}</div> : null}
                  {runnerAuthStatus.callbackPort && !["completed", "failed", "cancelled"].includes(runnerAuthStatus.status) ? (
                    <div className="mt-2 space-y-1">
                      <input
                        value={runnerAuthCallbackUrl}
                        onChange={(event) => setRunnerAuthCallbackUrl(event.target.value)}
                        onPaste={(event) => {
                          const pasted = event.clipboardData.getData("text") || "";
                          const cleaned = pasted.trim();
                          if (cleaned !== pasted) {
                            event.preventDefault();
                            setRunnerAuthCallbackUrl(cleaned);
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && runnerAuthCallbackUrl.trim()) {
                            event.preventDefault();
                            void submitRunnerAuthCallback();
                          }
                        }}
                        placeholder={`http://localhost:${runnerAuthStatus.callbackPort}/callback?...`}
                        spellCheck={false}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        className="w-full rounded-md border border-[#d7dce3] bg-white px-2 py-1.5 font-mono text-[11px] text-[#1f2933] outline-none focus:border-[#98a2b3] dark:border-[#2a3039] dark:bg-[#0b0d11] dark:text-[#e6e8ec]"
                      />
                      <button
                        type="button"
                        disabled={!runnerAuthCallbackUrl.trim() || runnerAuthCallbackBusy}
                        onClick={() => void submitRunnerAuthCallback()}
                        className="rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-[11px] font-semibold text-sky-700 disabled:opacity-40 dark:text-sky-200"
                      >
                        {runnerAuthCallbackBusy ? "Delivering..." : "Deliver callback"}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {runnerAuthError ? <div className="text-[11px] text-rose-700 dark:text-rose-300">{runnerAuthError}</div> : null}
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
