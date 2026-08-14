import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../src/context/AuthContext";
import { Device, useDevice } from "../../src/context/DeviceContext";
import { useColors } from "../../src/context/ThemeContext";
import { quicClient } from "../../src/lib/quic";
import { getUserSettings } from "../../src/lib/auth";

type Project = { name: string; path: string; framework?: string };
type DevStatus = {
  framework?: string;
  kind?: string;
  running: boolean;
  serving: boolean;
  servingLabel?: string;
  port?: number;
  vibeSessionId?: string;
  previewHealth?: { state?: string; reason?: string };
};

function deviceBaseUrl(device: Device, token: string | null): string | null {
  const relays = quicClient.getRelayServers();
  if (relays.length > 0) return `${relays[0].httpUrl}/d/${device.id}`;
  return `http://${device.host}:${device.port}`;
}

export default function VibingScreen() {
  const c = useColors();
  const { token } = useAuth();
  const { activeDevice, connectionStatus } = useDevice();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [status, setStatus] = useState<DevStatus | null>(null);
  const [working, setWorking] = useState(false);
  const [laneHtml, setLaneHtml] = useState<string>("");
  const [frameUri, setFrameUri] = useState<string>("");
  const [frameError, setFrameError] = useState<string>("");
  const [transport, setTransport] = useState<"auto" | "sse" | "webrtc">("auto");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const base = activeDevice && token ? deviceBaseUrl(activeDevice, token) : null;

  // Load transport preference
  useEffect(() => {
    getUserSettings(token ?? "").then((s) => {
      if (s.vibingTransport) setTransport(s.vibingTransport);
    }).catch(() => {});
  }, [token]);

  // Load projects on connect
  useEffect(() => {
    if (!base || !token) return;
    fetch(`${base}/projects?refresh=1`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((d) => {
        const list: Project[] = d.projects || [];
        setProjects(list);
        if (list.length > 0) setSelected(list[0].path);
      })
      .catch(() => {});
  }, [base, token]);

  const refreshStatus = useCallback(async () => {
    if (!base || !token) return;
    try {
      const r = await fetch(`${base}/dev/status`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setStatus(await r.json());
    } catch {}
  }, [base, token]);

  useEffect(() => {
    refreshStatus();
    pollRef.current = setInterval(refreshStatus, 4000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refreshStatus]);

  const startPreview = async () => {
    if (!base || !token || !selected) return;
    setWorking(true);
    setLaneHtml("");
    try {
      const r = await fetch(`${base}/dev/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ workDir: selected }),
      });
      if (r.ok) setStatus(await r.json());
      await refreshStatus();
    } catch {}
    setWorking(false);
  };

  const stopPreview = async () => {
    if (!base || !token) return;
    setWorking(true);
    try {
      await fetch(`${base}/dev/stop`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      setStatus(null);
      setLaneHtml("");
      await refreshStatus();
    } catch {}
    setWorking(false);
  };

  const verifyLane = async () => {
    // Headless lane proof: fetch the running app HTML with auth.
    if (!base || !token || !status?.serving) return;
    try {
      const r = await fetch(`${base}/dev/stream`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) {
        const html = await r.text();
        setLaneHtml(html.slice(0, 400));
      }
    } catch {}
  };

  // Live frame lane: poll the agent's /vibing/frame (headless Chrome capture of
  // the local dev server) and render as an image. 404 → endpoint not on this box.
  const fetchFrame = useCallback(async () => {
    if (!base || !token || !status?.serving || !status?.port) return;
    try {
      const localUrl = `http://localhost:${status.port}/`;
      const r = await fetch(
        `${base}/vibing/frame?url=${encodeURIComponent(localUrl)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (r.status === 404) {
        setFrameError("Frame endpoint not available on this box");
        return;
      }
      if (!r.ok) return;
      const buf = await r.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let b64 = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        b64 += String.fromCharCode(...Array.from(bytes.subarray(i, i + 0x8000)));
      }
      setFrameUri(`data:image/png;base64,${btoa(b64)}`);
      setFrameError("");
    } catch {
      // transient
    }
  }, [base, token, status]);

  useEffect(() => {
    if (!status?.serving) {
      setFrameUri("");
      return;
    }
    setFrameUri("");
    setFrameError("");
    fetchFrame();
    const iv = setInterval(fetchFrame, 2500);
    return () => clearInterval(iv);
  }, [status?.serving, fetchFrame]);

  const serving = !!status?.serving;
  const building = !serving && status?.running === false && !!status?.port;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.bg }]} edges={["bottom"]}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.headerRow}>
          <View style={styles.titleBlock}>
            <Text style={[styles.title, { color: c.textPrimary }]}>Vibing</Text>
            <Text style={[styles.subtitle, { color: c.textSecondary }]}>
              {activeDevice ? `Live preview · ${activeDevice.name}` : "Connect a device first"}
            </Text>
          </View>
          <View style={[styles.badge, { backgroundColor: serving ? c.success + "22" : c.textMuted + "22" }]}>
            <Text style={[styles.badgeText, { color: serving ? c.success : c.textMuted }]}>
              {serving ? "Serving" : "Idle"}
            </Text>
          </View>
        </View>

        {/* Transport */}
        <View style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.border }]}>
          <View style={styles.cardRow}>
            <Text style={[styles.cardLabel, { color: c.textPrimary }]}>Transport</Text>
            <Text style={[styles.cardValue, { color: c.accent }]}>
              {transport === "webrtc" ? "WebRTC" : transport === "sse" ? "SSE" : "Auto (SSE → WebRTC)"}
            </Text>
          </View>
          <Text style={[styles.hint, { color: c.textMuted }]}>
            SSE streams over the free relay. WebRTC (low latency) is the Relay Pro upgrade — set it in Settings → Vibing.
          </Text>
        </View>

        {/* Project picker */}
        <Text style={[styles.sectionLabel, { color: c.textPrimary }]}>Project on device</Text>
        <View style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.border }]}>
          {projects.length === 0 ? (
            <ActivityIndicator color={c.accent} style={{ marginVertical: 16 }} />
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {projects.map((p) => {
                const active = selected === p.path;
                return (
                  <Pressable
                    key={p.path}
                    onPress={() => setSelected(p.path)}
                    style={({ focused }) => [styles.chip, { borderColor: active ? c.accent : c.border, backgroundColor: active ? c.accent + "20" : c.bg }, focused && styles.chipFocused]}
                  >
                    <Text style={{ color: active ? c.accent : c.textSecondary, fontSize: 16 }} numberOfLines={1}>
                      {p.name}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
        </View>

        {/* Status */}
        <View style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.border }]}>
          <View style={styles.cardRow}>
            <Text style={[styles.cardLabel, { color: c.textPrimary }]}>Dev server</Text>
            <Text style={[styles.cardValue, { color: c.textSecondary }]}>
              {status ? status.servingLabel || (building ? "Starting…" : "Not serving") : "Not serving"}
            </Text>
          </View>
          {status && (
            <>
              <View style={styles.cardRow}>
                <Text style={[styles.cardLabel, { color: c.textPrimary }]}>Framework</Text>
                <Text style={[styles.cardValue, { color: c.textSecondary }]}>{status.framework || "-"} · port {status.port || "-"}</Text>
              </View>
              {status.vibeSessionId && (
                <View style={styles.cardRow}>
                  <Text style={[styles.cardLabel, { color: c.textPrimary }]}>Session</Text>
                  <Text style={[styles.cardValue, { color: c.textSecondary }]}>{status.vibeSessionId}</Text>
                </View>
              )}
            </>
          )}
          {status?.previewHealth?.reason ? (
            <Text style={[styles.hint, { color: c.warn }]}>{status.previewHealth.reason}</Text>
          ) : null}
        </View>

        {/* Controls */}
        <View style={styles.controls}>
          <Pressable
            hasTVPreferredFocus
            disabled={working || !selected}
            onPress={startPreview}
            style={({ focused }) => [styles.btnPrimary, { backgroundColor: c.accent }, focused && styles.focused, (working || !selected) && { opacity: 0.5 }]}
          >
            <Text style={styles.btnPrimaryText}>{working ? "Working…" : serving ? "Restart preview" : "Start preview"}</Text>
          </Pressable>
          <Pressable
            disabled={working || !serving}
            onPress={stopPreview}
            style={({ focused }) => [styles.btnGhost, { borderColor: c.border }, focused && styles.focused, (!serving || working) && { opacity: 0.5 }]}
          >
            <Text style={[styles.btnGhostText, { color: c.error }]}>Stop</Text>
          </Pressable>
        </View>

        {/* Lane proof */}
        {serving && (
          <>
            {frameUri ? (
              <View style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.border, alignItems: "center" }]}>
                <Text style={[styles.cardLabel, { color: c.textPrimary, alignSelf: "flex-start" }]}>
                  Live preview {frameError ? "" : "· frames"} ✓
                </Text>
                <Image
                  source={{ uri: frameUri }}
                  style={styles.liveFrame}
                  resizeMode="contain"
                />
              </View>
            ) : (
              <Pressable
                onPress={verifyLane}
                style={({ focused }) => [styles.card, { backgroundColor: c.bgCard, borderColor: c.border }, focused && styles.focused]}
              >
                <Text style={[styles.cardLabel, { color: c.textPrimary }]}>
                  {laneHtml ? "Live lane verified ✓" : "Verify live lane (headless)"}
                </Text>
                {laneHtml ? (
                  <Text style={[styles.laneSnippet, { color: c.textSecondary }]} numberOfLines={4}>{laneHtml}</Text>
                ) : (
                  <Text style={[styles.hint, { color: c.textMuted }]}>
                    {frameError || "Fetching the running app from the box with auth — confirms the streaming lane. Full visual rendering needs the frame endpoint (self-host) or WebRTC (Relay Pro)."}
                  </Text>
                )}
              </Pressable>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { padding: 48, paddingBottom: 80 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 28 },
  titleBlock: {},
  title: { fontSize: 48, fontWeight: "800" },
  subtitle: { fontSize: 20, marginTop: 4 },
  badge: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8 },
  badgeText: { fontSize: 16, fontWeight: "700", textTransform: "uppercase" },
  sectionLabel: { fontSize: 22, fontWeight: "700", marginTop: 18, marginBottom: 8 },
  card: { borderRadius: 16, borderWidth: 1, padding: 20, marginBottom: 12 },
  cardRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  cardLabel: { fontSize: 17, fontWeight: "600" },
  cardValue: { fontSize: 17 },
  hint: { fontSize: 14, lineHeight: 20, marginTop: 4 },
  chip: {
    borderWidth: 1, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10, marginRight: 10,
  },
  chipFocused: { transform: [{ scale: 1.05 }] },
  controls: { flexDirection: "row", gap: 16, marginTop: 8 },
  btnPrimary: { borderRadius: 12, paddingHorizontal: 28, paddingVertical: 16, alignItems: "center" },
  btnPrimaryText: { color: "#fff", fontSize: 20, fontWeight: "700" },
  btnGhost: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 24, paddingVertical: 16, alignItems: "center" },
  btnGhostText: { fontSize: 20, fontWeight: "600" },
  focused: { transform: [{ scale: 1.03 }], opacity: 0.92 },
  laneSnippet: { fontSize: 12, marginTop: 8, fontFamily: "monospace" },
  liveFrame: { width: "100%", height: 420, marginTop: 12, borderRadius: 12 },
});
