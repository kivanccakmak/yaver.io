// vibe-studio.tsx — tablet Vibe Studio.
//
// Landscape (tablet-landscape): true split mirroring the tvOS
// RemoteRuntimeWebRTCView (40/58) and web VibeCodingView shapes —
//   LEFT  ≈55%  live app view
//   RIGHT ≈45%  chat + live console (StudioChatPane)
// The left pane has two lanes:
//   - "Browser" — DevPreview's WebView browser lane (interactive; box only
//     runs Metro/Vite, zero extra box load). This is the default when the
//     box reports a web target.
//   - "Live"    — LivePreviewPane frame lane (/vibing/preview/* SSE frames;
//     headless Chrome runs on the box, so use relay-wifi/cell profiles).
//
// Portrait (tablet-portrait): single-pane chat base with a "preview peek"
// panel — swipe/expand to bring the app view above the chat, collapsible.
//
// Everything here is additive and reuses the shared components (DevPreview,
// StudioChatPane, LivePreviewPane, AnsiConsoleText) — no task or preview
// machinery is re-implemented on this screen.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { AppScreenHeader } from "../src/components/AppScreenHeader";
import { DevPreview } from "../src/components/DevPreview";
import { LivePreviewPane } from "../src/components/studio/LivePreviewPane";
import { StudioChatPane } from "../src/components/studio/StudioChatPane";
import { useResponsiveLayout } from "../src/hooks/useResponsiveLayout";
import { useColors } from "../src/context/ThemeContext";
import { useDevice } from "../src/context/DeviceContext";
import { quicClient } from "../src/lib/quic";

type Lane = "browser" | "live";

type Project = { name: string; path: string; framework?: string; surfaces?: string[] };

export default function VibeStudioScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const layout = useResponsiveLayout();
  const { activeDevice, connectionStatus } = useDevice();
  const params = useLocalSearchParams<{ project?: string }>();
  const requestedProject = typeof params.project === "string" ? params.project.trim().toLowerCase() : "";
  const connected = connectionStatus === "connected" && !!activeDevice;

  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [paramMissed, setParamMissed] = useState<string | null>(null);
  const [lane, setLane] = useState<Lane>("browser");
  const [peekOpen, setPeekOpen] = useState(false);
  // Drag-divider split ratio (web parity — WebReloadView/RuntimeLabView). The
  // left preview pane flexes to splitRatio, the right chat pane to 1-splitRatio.
  const [splitRatio, setSplitRatio] = useState(0.55);
  const dividerDragRef = useRef<{ startX: number; startRatio: number } | null>(null);
  const rowWidthRef = useRef(0);
  const loadedOnceRef = useRef(false);

  const landscape = layout.layoutClass === "tablet-landscape";

  // Load projects from the box on connect. Auto-select the first mobile/web
  // project so the pane isn't empty on first open; the user can change it.
  const loadProjects = useCallback(async () => {
    if (!connected) return;
    setLoadingProjects(true);
    try {
      const list = await quicClient.listProjects(true);
      const mapped: Project[] = (list || [])
        .map((p) => ({ name: p.name, path: p.path, framework: p.framework, surfaces: p.surfaces }))
        .filter((p) => p.name && p.path);
      setProjects(mapped);
      if (!loadedOnceRef.current) {
        loadedOnceRef.current = true;
        const byParam = requestedProject
          ? mapped.find(
              (p) =>
                p.name.trim().toLowerCase() === requestedProject ||
                p.path.trim().toLowerCase() === requestedProject ||
                p.path.trim().toLowerCase().endsWith(`/${requestedProject}`),
            )
          : undefined;
        if (requestedProject && !byParam) {
          // The URL pinned a project the box does not have. Say so instead of
          // silently opening the first mobile project.
          setParamMissed(`Project "${requestedProject}" isn't on the connected box — pick one below.`);
          setProject(null);
        } else {
          setParamMissed(null);
          setProject(
            byParam ||
              mapped.find((p) => (p.surfaces || []).includes("mobile") || /expo|react-native|flutter|mobile/i.test(p.framework || "")) ||
              mapped[0] ||
              null,
          );
        }
      }
    } catch {
      // advisory — the picker stays available, the pane shows a connect hint
    } finally {
      setLoadingProjects(false);
    }
  }, [connected, requestedProject]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // Mark requests as coming from a tablet so the box tunes behavior for a
  // tablet-over-relay client (e.g. vibe-preview frame profile). Cleared on
  // unmount so phone navigation never inherits the marker.
  useEffect(() => {
    quicClient.setSurfaceMarker("mobile-tablet");
    return () => quicClient.clearSurfaceMarker();
  }, []);

  const handleRequestProject = useCallback(() => setShowProjectPicker(true), []);

  const pickProject = useCallback((p: Project) => {
    setProject(p);
    setParamMissed(null);
    setShowProjectPicker(false);
  }, []);

  const targetUrl = useCallback((): string | undefined => {
    if (!project) return undefined;
    // Browser-lane target for the frame lane: point headless Chrome at the
    // box's dev server when we can, else let the pane start on its own.
    return undefined;
  }, [project]);

  const headerRight = (
    <View style={styles.headerRight}>
      {landscape ? (
        <View style={styles.laneSwitcher}>
          {(["browser", "live"] as Lane[]).map((l) => (
            <Pressable
              key={l}
              onPress={() => setLane(l)}
              style={[styles.laneBtn, lane === l && { backgroundColor: c.accentSoft }]}
            >
              <Text style={[styles.laneBtnText, { color: lane === l ? c.accent : c.textSecondary }]}>
                {l === "browser" ? "Browser" : "Live"}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <Pressable
        onPress={handleRequestProject}
        style={[styles.projectBtn, { borderColor: c.border }]}
      >
        <Text style={{ color: c.textPrimary, fontSize: 12, fontWeight: "700" }} numberOfLines={1}>
          {project ? project.name : loadingProjects ? "Loading projects…" : "Pick project"}
        </Text>
      </Pressable>
    </View>
  );

  const projectPicker = showProjectPicker ? (
    <View style={[styles.pickerOverlay, { backgroundColor: "rgba(0,0,0,0.5)" }]}>
      <View style={[styles.pickerCard, { backgroundColor: c.bgCard, borderColor: c.border }]}>
        <View style={[styles.pickerHeader, { borderBottomColor: c.borderSubtle }]}>
          <Text style={[styles.pickerTitle, { color: c.textPrimary }]}>Project</Text>
          <Pressable onPress={() => setShowProjectPicker(false)} hitSlop={10}>
            <Ionicons name="close" size={18} color={c.textMuted} />
          </Pressable>
        </View>
        <View style={styles.pickerList}>
          {loadingProjects ? <ActivityIndicator color={c.textMuted} style={{ padding: 16 }} /> : null}
          {projects.map((p) => (
            <Pressable
              key={p.path}
              onPress={() => pickProject(p)}
              style={[styles.pickerRow, project?.path === p.path && { backgroundColor: c.accentSoft }]}
            >
              <Ionicons name="folder-open" size={16} color={c.accent} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: c.textPrimary, fontSize: 14, fontWeight: "600" }} numberOfLines={1}>
                  {p.name}
                </Text>
                <Text style={{ color: c.textMuted, fontSize: 11 }} numberOfLines={1}>
                  {p.path}
                </Text>
              </View>
              {p.framework ? <Text style={{ color: c.textMuted, fontSize: 11 }}>{p.framework}</Text> : null}
            </Pressable>
          ))}
          {projects.length === 0 && !loadingProjects ? (
            <Text style={{ color: c.textTertiary, padding: 16, fontSize: 13 }}>
              No projects discovered yet — connect a box and refresh.
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  ) : null;

  return (
    <View style={[styles.safe, { backgroundColor: c.bg }]}>
      <AppScreenHeader title="Vibe Studio" onBack={() => router.back()} right={headerRight} />

      {landscape ? (
        /* ── LANDSCAPE: preview LEFT / chat RIGHT ─────────────────── */
        <View
          style={styles.landscapeRow}
          testID="studio-landscape-row"
          onLayout={(e) => {
            rowWidthRef.current = e.nativeEvent.layout.width;
          }}
        >
          <View style={[styles.leftPane, { flex: splitRatio }]} testID="studio-left-pane">
            <View style={styles.deviceStage}>
              <View style={[styles.deviceFrame, { backgroundColor: "#09090b", borderColor: c.border }]}> 
                <View style={[styles.deviceSpeaker, { backgroundColor: c.border }]} />
                <View style={[styles.deviceScreen, { backgroundColor: c.bgCard }]}> 
                  {/* Persistent phone-frame content. The base empty pane sits
                      beneath EVERY lane so the frame is never a blank box while
                      the box has no dev server or the preview has not rendered
                      (paneMode DevPreview returns null until a status exists). */}
                  <View style={[styles.emptyPaneFill, { borderColor: c.borderSubtle }]}> 
                    <Ionicons name="phone-portrait-outline" size={28} color={c.textTertiary} />
                    <Text style={{ color: c.textTertiary, fontSize: 13, marginTop: 8, textAlign: "center" }}>
                      The mobile frame is ready. Pick a project or wait for the preview to load.
                    </Text>
                    {paramMissed ? (
                      <Text style={{ color: c.warn, fontSize: 12, marginTop: 8, textAlign: "center", paddingHorizontal: 12 }}>
                        {paramMissed}
                      </Text>
                    ) : null}
                  </View>
                  {lane === "browser" ? (
                    <View style={styles.paneHost}>
                      <DevPreview paneMode />
                    </View>
                  ) : project ? (
                    <View style={styles.paneHost}>
                      <LivePreviewPane key={project.path} project={project.name} targetUrl={targetUrl()} />
                    </View>
                  ) : null}
                </View>
              </View>
            </View>
          </View>
          {/* Drag divider — same pointer pattern as the web's split panes. */}
          <View
            style={styles.divider}
            testID="studio-divider"
            accessibilityRole="adjustable"
            accessibilityLabel="Resize preview split"
            onStartShouldSetResponder={() => true}
            onResponderGrant={(e) => {
              dividerDragRef.current = { startX: e.nativeEvent.pageX, startRatio: splitRatio };
            }}
            onResponderMove={(e) => {
              const d = dividerDragRef.current;
              if (!d) return;
              const w = rowWidthRef.current || 1;
              const ratio = Math.max(0.32, Math.min(0.72, d.startRatio + (e.nativeEvent.pageX - d.startX) / w));
              setSplitRatio(ratio);
            }}
            onResponderRelease={() => {
              dividerDragRef.current = null;
            }}
            onResponderTerminate={() => {
              dividerDragRef.current = null;
            }}
          >
            <View style={[styles.dividerKnob, { backgroundColor: c.border }]} />
          </View>
          <View style={[styles.rightPane, { flex: 1 - splitRatio }]} testID="studio-right-pane">
            <StudioChatPane
              projectPath={project?.path}
              projectName={project?.name}
              onRequestProject={handleRequestProject}
            />
          </View>
        </View>
      ) : (
        /* ── PORTRAIT: chat base + preview peek ────────────────────── */
        <View style={styles.portraitCol}>
          <View style={styles.portraitChat}>
            <StudioChatPane
              projectPath={project?.path}
              projectName={project?.name}
              onRequestProject={handleRequestProject}
            />
          </View>
          {peekOpen ? (
            <View style={[styles.peekPanel, { borderTopColor: c.border }]}>
              <View style={[styles.peekHeader, { borderBottomColor: c.borderSubtle }]}>
                <Text style={[styles.peekTitle, { color: c.textSecondary }]}>Preview</Text>
                <Pressable
                  onPress={() => setPeekOpen(false)}
                  hitSlop={8}
                  style={({ pressed }) => [styles.laneBtn, pressed && { opacity: 0.6 }]}
                >
                  <Text style={{ color: c.textMuted, fontSize: 12, fontWeight: "600" }}>Collapse</Text>
                </Pressable>
              </View>
              {project ? (
                <LivePreviewPane key={project.path} project={project.name} targetUrl={targetUrl()} height={280} />
              ) : (
                <View style={[styles.emptyPane, { borderColor: c.borderSubtle }]}>
                  <Text style={{ color: c.textTertiary, fontSize: 13 }}>Pick a project to preview.</Text>
                </View>
              )}
            </View>
          ) : (
            <Pressable
              onPress={() => setPeekOpen(true)}
              style={[styles.peekTab, { borderTopColor: c.border, backgroundColor: c.surface }]}
            >
              <Ionicons name="expand-outline" size={14} color={c.textSecondary} />
              <Text style={{ color: c.textSecondary, fontSize: 12, fontWeight: "600" }}>Preview</Text>
            </Pressable>
          )}
        </View>
      )}

      {projectPicker}
      <View style={{ height: insets.bottom }} />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  laneSwitcher: {
    flexDirection: "row",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    overflow: "hidden",
  },
  laneBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6 },
  laneBtnText: { fontSize: 12, fontWeight: "700" },
  projectBtn: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: 160,
  },
  landscapeRow: { flex: 1, flexDirection: "row", minHeight: 0 },
  leftPane: {
    minWidth: 0,
    padding: 10,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: "transparent",
  },
  divider: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "stretch",
    marginHorizontal: -4,
    zIndex: 3,
  },
  dividerKnob: {
    width: 4,
    height: 48,
    borderRadius: 2,
    opacity: 0.45,
  },
  deviceStage: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 0 },
  deviceFrame: {
    width: "100%",
    maxWidth: 430,
    height: "100%",
    maxHeight: 760,
    borderRadius: 30,
    borderWidth: 8,
    paddingTop: 8,
    paddingHorizontal: 4,
    paddingBottom: 8,
    alignItems: "center",
  },
  deviceSpeaker: { width: 76, height: 5, borderRadius: 3, marginBottom: 6 },
  deviceScreen: { flex: 1, width: "100%", minHeight: 0, borderRadius: 20, overflow: "hidden" },
  // Absolute-fill base beneath every lane so the phone frame is never blank
  // while the preview is loading or the box has no dev server.
  emptyPaneFill: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 20,
  },
  paneHost: {
    ...StyleSheet.absoluteFillObject,
    overflow: "hidden",
  },
  rightPane: { minWidth: 0 },
  portraitCol: { flex: 1, minHeight: 0 },
  portraitChat: { flex: 1, minHeight: 0 },
  peekPanel: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  peekHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  peekTitle: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },
  peekTab: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  emptyPane: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
  },
  pickerOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  pickerCard: {
    width: "90%",
    maxWidth: 480,
    maxHeight: "70%",
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
  },
  pickerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pickerTitle: { fontSize: 15, fontWeight: "700" },
  pickerList: { paddingVertical: 6 },
  pickerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
});
