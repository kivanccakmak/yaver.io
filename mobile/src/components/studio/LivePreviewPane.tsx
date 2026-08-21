// LivePreviewPane.tsx — the modern vibe frame lane as an EMBEDDED pane.
//
// Extracted from VibePreviewModal so the tablet Vibe Studio (and any future
// surface) can place the live "watch the agent change the app" frame lane
// beside a chat pane instead of only inside a full-screen Modal. Same
// transport as the modal: /vibing/preview/start → /vibing/preview/events
// SSE → content-addressed /vibing/preview/frames/{hash} <Image>, with
// net-mode profiles (live-relay-wifi / live-relay-cell) picked for a
// relay-connected tablet. Reuses src/lib/vibePreview — no duplicate
// transport here, only a different host.

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  frameUrl,
  listSessions,
  startPreview,
  stopPreview,
  subscribeEvents,
} from "../../lib/vibePreview";
import { quicClient } from "../../lib/quic";
import { useColors } from "../../context/ThemeContext";
import { useResponsiveLayout } from "../../hooks/useResponsiveLayout";

interface LivePreviewPaneProps {
  project: string;
  targetUrl?: string;
  /** Auto-start the capture when mounted (default true). The web
   *  dashboard's Vibing view and the phone's vibing tab keep the session
   *  alive across navigations, so this is best-effort idempotent. */
  autoStart?: boolean;
  /** Fixed height for the pane (used in a vertical portrait split).
   *  Omit for flex-fill in a landscape row. */
  height?: number;
  onSessionError?: (message: string) => void;
}

export function LivePreviewPane({
  project,
  targetUrl,
  autoStart = true,
  height,
  onSessionError,
}: LivePreviewPaneProps) {
  const c = useColors();
  const layout = useResponsiveLayout();
  const [latestHash, setLatestHash] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState<string>("");
  const unsubscribeRef = useRef<null | (() => void)>(null);
  const startedRef = useRef(false);

  // Establish or reuse a session, then subscribe to the SSE frame stream.
  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      if (startedRef.current) return;
      startedRef.current = true;
      setLoading(true);
      setError(null);
      try {
        const sessions = await listSessions();
        if (cancelled) return;
        let s = sessions.find((x) => x.project === project) || null;
        if (!s && autoStart && targetUrl) {
          setStarting(true);
          s = await startPreview({ project, targetUrl, mode: "live" });
          setStarting(false);
        }
        if (cancelled) return;
        if (s) setFps(`${s.profile.fps} fps · ${s.profile.name}`);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setLoading(false);
        const msg = e instanceof Error ? e.message : "Could not start preview";
        setError(msg);
        onSessionError?.(msg);
      }
    };
    void start();
    return () => {
      cancelled = true;
    };
  }, [project, targetUrl, autoStart, onSessionError]);

  // Live event subscription — re-establishes when project changes.
  useEffect(() => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
    const unsub = subscribeEvents(project, {
      onEvent: (ev) => {
        if (ev.type === "frame" && ev.hash) setLatestHash(ev.hash);
      },
      onError: () => {
        // Frame stream dropped — keep the last good frame visible and let
        // the next reconnect fill it in (no modal, no spinner over content).
      },
    });
    unsubscribeRef.current = unsub;
    return () => {
      if (unsubscribeRef.current) unsubscribeRef.current();
      unsubscribeRef.current = null;
    };
  }, [project]);

  // Stop the capture when the pane unmounts so headless Chrome isn't left
  // eating RAM on a 4 GB box (the box renders the capture in this lane).
  useEffect(() => {
    return () => {
      if (startedRef.current) void stopPreview(project);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  const frameSrc = useMemo(() => {
    if (!latestHash) return null;
    const u = frameUrl(project, latestHash);
    if (!u) return null;
    return { uri: u, headers: quicClient.getAuthHeaders() };
  }, [project, latestHash]);

  const compact = layout.layoutClass !== "tablet-landscape";

  return (
    <View style={[styles.wrap, { backgroundColor: "#000", borderColor: c.border }, height ? { height } : styles.flexFill]}>
      {/* Header strip: project + fps + clear */}
      <View style={[styles.header, { borderBottomColor: c.borderSubtle }]}>
        <Text style={[styles.title, { color: c.textPrimary }]} numberOfLines={1}>
          Live · {project}
        </Text>
        <View style={styles.headerRight}>
          {fps ? <Text style={[styles.fps, { color: c.textMuted }]}>{fps}</Text> : null}
          {latestHash ? (
            <Pressable
              hitSlop={8}
              onPress={() => setLatestHash(null)}
              accessibilityRole="button"
              accessibilityLabel="Clear preview"
            >
              <Ionicons name="close" size={16} color={c.textMuted} />
            </Pressable>
          ) : null}
        </View>
      </View>

      <View style={styles.body}>
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color="#22c55e" size="small" />
            <Text style={[styles.hint, { color: c.textMuted }]}>
              {starting ? "Starting headless capture on the box…" : "Resuming preview…"}
            </Text>
          </View>
        ) : error ? (
          <View style={styles.center}>
            <Text style={[styles.errTitle, { color: c.error }]}>Preview unavailable</Text>
            <Text style={[styles.hint, { color: c.textMuted }]} numberOfLines={3}>
              {error}
            </Text>
            {targetUrl ? (
              <Pressable
                onPress={() => {
                  setLoading(true);
                  setError(null);
                  void startPreview({ project, targetUrl, mode: "live" })
                    .then((s) => {
                      setLoading(false);
                      if (s) setFps(`${s.profile.fps} fps · ${s.profile.name}`);
                    })
                    .catch((e: Error) => {
                      setLoading(false);
                      setError(e.message || "Could not start preview");
                    });
                }}
                style={[styles.retryBtn, { backgroundColor: c.accentSoft }]}
              >
                <Text style={{ color: c.accent, fontSize: 13, fontWeight: "700" }}>Retry</Text>
              </Pressable>
            ) : null}
          </View>
        ) : frameSrc ? (
          <Image source={frameSrc as any} style={styles.frame} resizeMode="contain" />
        ) : (
          <View style={styles.center}>
            <Text style={[styles.hint, { color: c.textMuted }]}>
              Waiting for the first frame… (run a vibe task to watch it change)
            </Text>
          </View>
        )}
        {!compact && latestHash ? (
          <View style={styles.cornerBadge}>
            <Text style={{ color: "#4ade80", fontSize: 10, fontWeight: "700" }}>● live</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    minHeight: 0,
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
  },
  flexFill: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { fontSize: 13, fontWeight: "700", flex: 1 },
  fps: { fontSize: 10, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4 },
  body: { flex: 1, minHeight: 0 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16, gap: 8 },
  hint: { fontSize: 12, textAlign: "center", lineHeight: 18 },
  errTitle: { fontSize: 14, fontWeight: "700" },
  retryBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, marginTop: 4 },
  frame: { flex: 1, width: "100%" },
  cornerBadge: {
    position: "absolute",
    top: 8,
    right: 10,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
});
