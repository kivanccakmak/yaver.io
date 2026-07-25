import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { WebView } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useColors } from "../../src/context/ThemeContext";
import { useTabletContentStyle } from "../../src/hooks/useTabletContentStyle";
import { quicClient, type DevServerStatus, type RemoteRuntimeCapabilities } from "../../src/lib/quic";
import { isActiveDevServerStatus } from "../../src/lib/devServerState";
import { AppBackButton } from "../../src/components/AppBackButton";

type EnvState = { active: string; envs: string[] };
type ProjectSummary = {
  name?: string;
  path?: string;
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
  tags?: string[];
  webCapable?: boolean;
  mobileCapable?: boolean;
  executionMode?: string;
  primarySurface?: string;
  gitRemote?: string;
};
type GitStatus = { branch?: string; ahead?: number; behind?: number; clean?: boolean; staged?: unknown[]; modified?: unknown[]; untracked?: unknown[] };
type GitCommit = { shortHash?: string; hash?: string; message?: string; author?: string; date?: string };
type RepoInfo = { name?: string; path?: string; branch?: string; remote?: string; dirty?: boolean; stack?: { type?: string; frameworks?: string[]; services?: string[]; actions?: string[] } };

export default function ProjectDetailScreen() {
  const c = useColors();
  const tabletContent = useTabletContentStyle("regular");
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ dir?: string }>();
  const [dir, setDir] = useState<string>(typeof params.dir === "string" ? params.dir : "");
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [lastCommit, setLastCommit] = useState<GitCommit | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [env, setEnv] = useState<EnvState | null>(null);
  const [devStatus, setDevStatus] = useState<DevServerStatus | null>(null);
  const [caps, setCaps] = useState<RemoteRuntimeCapabilities | null>(null);
  const [renderUrl, setRenderUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [rendering, setRendering] = useState<"web" | "phone" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const q = dir ? `?directory=${encodeURIComponent(dir)}` : "";
  const slug = dir.split("/").filter(Boolean).pop() || project?.name || "project";
  const framework = useMemo(() => {
    const fromStack = repo?.stack?.frameworks?.[0];
    return String(project?.framework || project?.stack || fromStack || status?.kind || "").replace(/\.js$/, "");
  }, [project?.framework, project?.stack, repo?.stack?.frameworks, status?.kind]);
  const stackLabels = useMemo(() => {
    const values = [
      project?.framework,
      ...(project?.frameworks || []),
      project?.stack,
      ...(project?.stacks || []),
      project?.backend,
      ...(project?.services || []),
      ...(project?.hosting || []),
      ...(repo?.stack?.frameworks || []),
      ...(repo?.stack?.services || []),
      ...(project?.tags || []),
    ].filter(Boolean).map((v) => String(v));
    return Array.from(new Set(values));
  }, [project, repo]);
  const platforms = useMemo(() => {
    const values = new Set<string>();
    for (const surface of project?.surfaces || []) values.add(labelSurface(surface));
    for (const surface of project?.testSurfaces || []) values.add(labelRenderSurface(surface));
    if (project?.webCapable || stackLabels.some((s) => ["next", "next.js", "vite", "web", "react-native-web"].includes(s.toLowerCase()))) values.add("Web UI");
    if (project?.mobileCapable || stackLabels.some((s) => ["expo", "react-native", "flutter", "swift", "kotlin", "mobile"].includes(s.toLowerCase()))) {
      values.add("Mobile");
      values.add("Tablet");
    }
    for (const target of caps?.targets || []) {
      if (target.surface) values.add(labelSurface(target.surface));
      else if (target.platform) values.add(labelSurface(target.platform));
    }
    if (repo?.stack?.services?.length || status?.kind) values.add("Backend");
    return Array.from(values);
  }, [caps?.targets, project?.mobileCapable, project?.surfaces, project?.testSurfaces, project?.webCapable, repo?.stack?.services, stackLabels, status?.kind]);

  const loadAll = useCallback(async () => {
    if (!dir.trim()) return;
    setLoading(true);
    setError(null);
    const [backendRes, envRes, projectsRes, mobileRes, reposRes, gitRes, logRes, devRes] = await Promise.allSettled([
      call(`/backend/status${q}`),
      call(`/project/env/list${q}`),
      quicClient.listProjectsDetailed(),
      quicClient.listMobileProjectsDetailed(),
      quicClient.listRepos(),
      quicClient.gitStatus(dir),
      quicClient.gitLog(dir, 1),
      quicClient.getDevServerStatus(),
    ]);

    if (backendRes.status === "fulfilled") setStatus(backendRes.value);
    if (envRes.status === "fulfilled") setEnv(envRes.value);

    const discovered = projectsRes.status === "fulfilled" && Array.isArray(projectsRes.value?.projects)
      ? projectsRes.value.projects
      : [];
    const mobile = mobileRes.status === "fulfilled" ? mobileRes.value.projects : [];
    const match = [...discovered, ...mobile].find((p: ProjectSummary) => normalizePath(p.path) === normalizePath(dir));
    setProject(match || { name: slug, path: dir, framework: status?.kind });

    const repos = reposRes.status === "fulfilled" ? reposRes.value : [];
    setRepo(repos.find((r) => normalizePath(r.path) === normalizePath(dir)) || null);
    setGitStatus(gitRes.status === "fulfilled" ? gitRes.value : null);
    setLastCommit(logRes.status === "fulfilled" ? logRes.value?.[0] || null : null);

    const activeDev = devRes.status === "fulfilled" && isActiveDevServerStatus(devRes.value) ? devRes.value : null;
    setDevStatus(activeDev);
    if (activeDev?.workDir && normalizePath(activeDev.workDir) === normalizePath(dir)) {
      const lane = (activeDev as any).webPort ? "/dev-web/" : activeDev.bundleUrl || "/dev/";
      setRenderUrl(quicClient.getDevServerBundleUrl(lane));
    }

    const nextFramework = String(match?.framework || match?.stack || framework || "");
    if (nextFramework) {
      try {
        setCaps(await quicClient.getRemoteRuntimeCapabilities(dir, nextFramework));
      } catch {
        setCaps(null);
      }
    } else {
      setCaps(null);
    }
    setLoading(false);
  }, [dir, framework, q, slug, status?.kind]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  async function switchEnv(name: string) {
    await call(`/project/env/switch${q}`, { method: "POST", body: JSON.stringify({ name }) });
    void loadAll();
  }

  async function renderWeb() {
    if (!dir.trim()) return;
    setRendering("web");
    try {
      const st = await quicClient.startDevServer({ framework, workDir: dir, web: true });
      const fresh = st || await quicClient.getDevServerStatus();
      setDevStatus(fresh);
      const lane = (fresh as any)?.webPort ? "/dev-web/" : fresh?.bundleUrl || "/dev/";
      setRenderUrl(quicClient.getDevServerBundleUrl(lane));
    } catch (e) {
      Alert.alert("Could not render Web UI", e instanceof Error ? e.message : String(e));
    } finally {
      setRendering(null);
    }
  }

  async function renderPhone() {
    if (!dir.trim()) return;
    setRendering("phone");
    try {
      await quicClient.startDevServer({ framework, workDir: dir });
      Alert.alert("Phone render started", "Yaver is loading the app into this phone when the bundle is ready.");
      void loadAll();
    } catch (e) {
      Alert.alert("Could not render on phone", e instanceof Error ? e.message : String(e));
    } finally {
      setRendering(null);
    }
  }

  const dirtyCount = (gitStatus?.staged?.length || 0) + (gitStatus?.modified?.length || 0) + (gitStatus?.untracked?.length || 0);
  const canPhoneRender = stackLabels.some((s) => ["expo", "react-native"].includes(s.toLowerCase()));

  return (
    <View style={[styles.container, { backgroundColor: c.bg }]}>
      <View style={[styles.header, { borderBottomColor: c.border, paddingTop: insets.top + 12 }]}>
        <AppBackButton onPress={() => router.back()} />
        <Text style={{ fontSize: 17, fontWeight: "700", color: c.textPrimary }} numberOfLines={1}>{slug}</Text>
        <Pressable onPress={loadAll} style={[styles.headerButton, { borderColor: c.border }]}>
          {loading ? <ActivityIndicator size="small" color={c.accent} /> : <Text style={{ color: c.accent, fontWeight: "700", fontSize: 12 }}>Refresh</Text>}
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={[{ padding: 16, paddingBottom: 40, gap: 14 }, tabletContent]}>
        <TextInput
          value={dir}
          onChangeText={setDir}
          placeholder="project directory"
          placeholderTextColor={c.textMuted}
          autoCapitalize="none"
          style={[inputStyle(c), { fontFamily: "Menlo", fontSize: 12 }]}
        />

        {error ? <Text style={{ color: "#ef4444", fontSize: 12 }}>{error}</Text> : null}

        <View style={{ gap: 8 }}>
          <Text style={[styles.label, { color: c.textMuted }]}>Project</Text>
          <View style={[card(c), { gap: 8 }]}>
            <Text style={{ color: c.textPrimary, fontSize: 18, fontWeight: "800" }} numberOfLines={1}>{project?.name || slug}</Text>
            <Text style={{ color: c.textMuted, fontFamily: "Menlo", fontSize: 11 }} numberOfLines={2}>{dir || "No path selected"}</Text>
            <View style={styles.wrap}>
              {stackLabels.length ? stackLabels.slice(0, 8).map((label) => <Pill key={label} c={c} label={label} tone="accent" />) : <Pill c={c} label="stack unknown" />}
            </View>
          </View>
        </View>

        <View style={{ gap: 8 }}>
          <Text style={[styles.label, { color: c.textMuted }]}>Git</Text>
          <View style={[card(c), { gap: 8 }]}>
            <MetaRow c={c} label="Branch" value={gitStatus?.branch || repo?.branch || project?.branch || "unknown"} />
            <MetaRow c={c} label="Remote" value={repo?.remote || project?.gitRemote || "none"} mono />
            <MetaRow c={c} label="Commit" value={lastCommit ? `${lastCommit.shortHash || lastCommit.hash?.slice(0, 8) || ""} ${lastCommit.message || ""}` : "unknown"} mono />
            <View style={styles.wrap}>
              <Pill c={c} label={gitStatus?.clean === false || repo?.dirty ? `${dirtyCount || "some"} changed` : "clean"} tone={gitStatus?.clean === false || repo?.dirty ? "warn" : "ok"} />
              {typeof gitStatus?.ahead === "number" && gitStatus.ahead > 0 ? <Pill c={c} label={`${gitStatus.ahead} ahead`} tone="warn" /> : null}
              {typeof gitStatus?.behind === "number" && gitStatus.behind > 0 ? <Pill c={c} label={`${gitStatus.behind} behind`} tone="warn" /> : null}
            </View>
          </View>
        </View>

        {env?.envs?.length ? (
          <View style={{ gap: 8 }}>
            <Text style={[styles.label, { color: c.textMuted }]}>Environment</Text>
            <View style={styles.wrap}>
              {env.envs.map((n) => <Chip key={n} c={c} label={n} active={env.active === n} onPress={() => switchEnv(n)} />)}
            </View>
          </View>
        ) : null}

        <View style={{ gap: 8 }}>
          <Text style={[styles.label, { color: c.textMuted }]}>Platforms</Text>
          <View style={styles.wrap}>
            {platforms.length ? platforms.map((p) => <Pill key={p} c={c} label={p} />) : <Pill c={c} label="No runnable platform detected" />}
          </View>
        </View>

        <View style={{ gap: 8 }}>
          <Text style={[styles.label, { color: c.textMuted }]}>Render</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable onPress={renderWeb} style={[actionBtn(c), { backgroundColor: c.accent, flex: 1 }]}>
              <Text style={styles.primaryActionText}>{rendering === "web" ? "Starting..." : "Web UI"}</Text>
            </Pressable>
            <Pressable
              onPress={() => router.navigate({ pathname: "/remote-runtime", params: { project: project?.name || slug, path: dir, framework } } as any)}
              style={[actionBtn(c), { backgroundColor: c.bgCard, borderColor: c.border, borderWidth: 1, flex: 1 }]}
            >
              <Text style={{ color: c.textPrimary, fontWeight: "700" }}>Device Stream</Text>
            </Pressable>
            <Pressable
              onPress={renderPhone}
              disabled={!canPhoneRender || rendering === "phone"}
              style={[actionBtn(c), { backgroundColor: c.bgCard, borderColor: c.border, borderWidth: 1, flex: 1, opacity: canPhoneRender ? 1 : 0.45 }]}
            >
              <Text style={{ color: c.textPrimary, fontWeight: "700" }}>{rendering === "phone" ? "Starting..." : "Phone"}</Text>
            </Pressable>
          </View>
          {caps?.targets?.length ? (
            <View style={styles.wrap}>
              {caps.targets.map((target) => (
                <Pill
                  key={target.id}
                  c={c}
                  label={`${target.label}${target.enabled ? "" : " unavailable"}`}
                  tone={target.enabled ? "ok" : "muted"}
                />
              ))}
            </View>
          ) : null}
        </View>

        <Pressable
          onPress={() => router.navigate({ pathname: "/(tabs)/tasks", params: { dir } } as any)}
          style={[actionBtn(c), { backgroundColor: c.bgCard, borderColor: c.border, borderWidth: 1 }]}
        >
          <Text style={{ color: c.textPrimary, fontWeight: "700" }}>Vibe in this project</Text>
        </Pressable>

        {status?.url || devStatus?.bundleUrl ? (
          <View style={[card(c), { flexDirection: "row", alignItems: "center", gap: 8 }]}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: status?.running || devStatus?.running ? "#10b981" : "#f59e0b" }} />
            <Text style={{ color: c.textPrimary, fontSize: 12, flex: 1 }} numberOfLines={1}>
              {status?.url || devStatus?.bundleUrl || "starting"}
            </Text>
          </View>
        ) : null}

        {renderUrl ? (
          <View style={[styles.previewShell, { borderColor: c.border, backgroundColor: c.bgCard }]}>
            <View style={[styles.previewHeader, { borderBottomColor: c.border }]}>
              <Text style={{ color: c.textPrimary, fontSize: 12, fontWeight: "700" }}>Web UI</Text>
              <Text style={{ color: c.textMuted, fontSize: 11 }} numberOfLines={1}>{framework || "web"}</Text>
            </View>
            <WebView
              source={{ uri: renderUrl }}
              style={{ flex: 1, backgroundColor: c.bg }}
              javaScriptEnabled
              domStorageEnabled
              startInLoadingState
            />
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

async function call(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${quicClient.baseUrl}${path}`, {
    ...init,
    headers: { ...quicClient.getAuthHeaders(), "Content-Type": "application/json", ...(init.headers || {}) },
  });
  return res.json();
}

function normalizePath(path?: string) {
  return String(path || "").replace(/\/+$/, "");
}

function labelSurface(surface: string) {
  const s = String(surface || "").toLowerCase();
  if (s === "web" || s === "browser") return "Web UI";
  if (s === "backend" || s === "api") return "Backend";
  if (s === "mobile" || s === "ios" || s === "android") return "Mobile";
  if (s === "ipad" || s === "ipados" || s === "tablet") return "Tablet";
  if (s === "tvos" || s === "tv" || s === "android-tv") return "TV";
  if (s === "watchos" || s === "wear") return "Watch";
  if (s === "visionos" || s === "xr") return "Vision";
  if (s === "cli") return "CLI";
  return surface;
}

function labelRenderSurface(surface: string) {
  const s = String(surface || "").toLowerCase();
  if (s === "browser") return "Browser render";
  if (s === "rn-hermes") return "Hermes reload";
  if (s === "simulator") return "Simulator WebRTC";
  if (s === "emulator") return "Emulator WebRTC";
  if (s === "webrtc") return "Device WebRTC";
  return labelSurface(surface);
}

function MetaRow({ c, label, value, mono }: { c: any; label: string; value: string; mono?: boolean }) {
  return (
    <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
      <Text style={{ color: c.textMuted, fontSize: 11, width: 58 }}>{label}</Text>
      <Text style={{ color: c.textPrimary, fontSize: 12, flex: 1, fontFamily: mono ? "Menlo" : undefined }} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function Chip({ c, label, active, onPress }: { c: any; label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, backgroundColor: active ? c.accent + "25" : c.bgCard, borderWidth: 1, borderColor: active ? c.accent : c.border }}>
      <Text style={{ color: active ? c.accent : c.textMuted, fontSize: 12, fontWeight: "700" }}>{label}</Text>
    </Pressable>
  );
}

function Pill({ c, label, tone = "muted" }: { c: any; label: string; tone?: "muted" | "accent" | "ok" | "warn" }) {
  const color = tone === "accent" ? c.accent : tone === "ok" ? "#10b981" : tone === "warn" ? "#f59e0b" : c.textMuted;
  return (
    <View style={{ paddingHorizontal: 9, paddingVertical: 5, borderRadius: 999, backgroundColor: color + "18", borderWidth: 1, borderColor: color + "55" }}>
      <Text style={{ color, fontSize: 11, fontWeight: "700" }}>{label}</Text>
    </View>
  );
}

function card(c: any) { return { backgroundColor: c.bgCard, borderColor: c.border, borderWidth: 1, borderRadius: 8, padding: 12 } as const; }
function actionBtn(c: any) { return { minHeight: 44, paddingHorizontal: 10, borderRadius: 8, alignItems: "center", justifyContent: "center" } as const; }
function inputStyle(c: any) { return { backgroundColor: c.bgCard, borderColor: c.border, borderWidth: 1, borderRadius: 8, padding: 10, color: c.textPrimary } as const; }

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1 },
  headerButton: { width: 68, height: 34, alignItems: "center", justifyContent: "center", borderWidth: 1, borderRadius: 8 },
  label: { fontSize: 10, fontWeight: "800", textTransform: "uppercase" },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  primaryActionText: { color: "#fff", fontWeight: "700" },
  previewShell: { height: 420, borderWidth: 1, borderRadius: 8, overflow: "hidden" },
  previewHeader: { height: 38, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1 },
});
