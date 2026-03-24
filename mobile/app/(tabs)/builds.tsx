import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  NativeModules,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useDevice } from "../../src/context/DeviceContext";
import { useColors } from "../../src/context/ThemeContext";
import { quicClient } from "../../src/lib/quic";
import type { BuildSummary, DownloadProgress } from "../../src/lib/builds";
import {
  downloadArtifact,
  formatSize,
  canInstallArtifact,
  installIPA,
} from "../../src/lib/builds";

// ── Status helpers ──────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  running: "#6366f1",
  completed: "#22c55e",
  failed: "#ef4444",
  cancelled: "#a1a1aa",
};

function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? "#a1a1aa";
  return (
    <View style={[styles.badge, { backgroundColor: color + "22" }]}>
      {status === "running" && (
        <ActivityIndicator size="small" color={color} style={{ marginRight: 4 }} />
      )}
      <Text style={[styles.badgeText, { color }]}>{status}</Text>
    </View>
  );
}

function PlatformBadge({ platform }: { platform: string }) {
  return (
    <View style={[styles.badge, { backgroundColor: "#3b82f622" }]}>
      <Text style={[styles.badgeText, { color: "#60a5fa" }]}>{platform}</Text>
    </View>
  );
}

// ── Build Item ──────────────────────────────────────────────────────

function BuildItem({ build, onRefresh }: { build: BuildSummary; onRefresh: () => void }) {
  const c = useColors();
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [localPath, setLocalPath] = useState<string | null>(null);

  const handleDownload = useCallback(async () => {
    if (!build.artifactName) return;
    setDownloading(true);
    setProgress(null);
    try {
      const path = await downloadArtifact(
        quicClient.baseUrl,
        quicClient.getAuthHeaders(),
        build.id,
        (p) => setProgress(p),
      );
      setLocalPath(path);
      Alert.alert("Downloaded", `Saved to ${path}`);
    } catch (e) {
      Alert.alert("Download failed", e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  }, [build.id, build.artifactName]);

  const handleInstall = useCallback(async () => {
    if (!localPath && !build.artifactName) return;

    // iOS OTA install
    if (Platform.OS === "ios" && build.artifactName?.toLowerCase().endsWith(".ipa")) {
      try {
        const manifestUrl = `${quicClient.baseUrl}/builds/${build.id}/manifest`;
        await installIPA(manifestUrl);
      } catch (e) {
        Alert.alert("Install failed", e instanceof Error ? e.message : String(e));
      }
      return;
    }

    // Android APK install
    if (Platform.OS === "android" && localPath) {
      try {
        await NativeModules.ApkInstaller.install(localPath);
      } catch (e) {
        Alert.alert("Install failed", e instanceof Error ? e.message : String(e));
      }
    } else if (Platform.OS === "android" && !localPath) {
      Alert.alert("Download first", "Download the artifact before installing.");
    }
  }, [localPath, build.id, build.artifactName]);

  const showInstall = build.status === "completed" && build.artifactName && canInstallArtifact(build.artifactName);

  return (
    <View style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.border }]}>
      <View style={styles.cardHeader}>
        <Text style={[styles.buildId, { color: c.textMuted }]} numberOfLines={1}>
          {build.id.slice(0, 8)}
        </Text>
        <PlatformBadge platform={build.platform} />
        <StatusBadge status={build.status} />
      </View>

      {build.artifactName && (
        <View style={styles.artifactRow}>
          <Text style={[styles.artifactName, { color: c.textPrimary }]} numberOfLines={1}>
            {build.artifactName}
          </Text>
          {build.artifactSize != null && (
            <Text style={[styles.artifactSize, { color: c.textMuted }]}>
              {formatSize(build.artifactSize)}
            </Text>
          )}
        </View>
      )}

      {downloading && progress && (
        <View style={styles.progressRow}>
          <View style={[styles.progressBar, { backgroundColor: c.border }]}>
            <View
              style={[styles.progressFill, { width: `${progress.percent}%`, backgroundColor: "#6366f1" }]}
            />
          </View>
          <Text style={[styles.progressText, { color: c.textMuted }]}>{progress.percent}%</Text>
        </View>
      )}

      <View style={styles.actions}>
        {build.status === "completed" && build.artifactName && (
          <Pressable
            style={[styles.actionBtn, { backgroundColor: "#6366f122" }]}
            onPress={handleDownload}
            disabled={downloading}
          >
            {downloading ? (
              <ActivityIndicator size="small" color="#818cf8" />
            ) : (
              <Text style={[styles.actionText, { color: "#818cf8" }]}>Download</Text>
            )}
          </Pressable>
        )}
        {showInstall && (
          <Pressable
            style={[styles.actionBtn, { backgroundColor: "#22c55e22" }]}
            onPress={handleInstall}
          >
            <Text style={[styles.actionText, { color: "#4ade80" }]}>Install</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

// ── Screen ──────────────────────────────────────────────────────────

export default function BuildsScreen() {
  const c = useColors();
  const { connectionStatus } = useDevice();
  const [builds, setBuilds] = useState<BuildSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isConnected = connectionStatus === "connected";

  const fetchBuilds = useCallback(async () => {
    if (!isConnected) return;
    try {
      const list = await quicClient.listBuilds();
      setBuilds(list);
    } catch {
      // silent
    }
  }, [isConnected]);

  // Initial fetch + poll every 5s
  useEffect(() => {
    if (!isConnected) {
      setBuilds([]);
      return;
    }
    setLoading(true);
    fetchBuilds().finally(() => setLoading(false));

    pollRef.current = setInterval(fetchBuilds, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [isConnected, fetchBuilds]);

  const renderItem = useCallback(
    ({ item }: { item: BuildSummary }) => <BuildItem build={item} onRefresh={fetchBuilds} />,
    [fetchBuilds],
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.bg }]} edges={["bottom"]}>
      {!isConnected ? (
        <View style={styles.center}>
          <Text style={[styles.emptyText, { color: c.textMuted }]}>
            Connect to a device to view builds
          </Text>
        </View>
      ) : loading && builds.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={c.textMuted} />
        </View>
      ) : builds.length === 0 ? (
        <View style={styles.center}>
          <Text style={[styles.emptyText, { color: c.textMuted }]}>No builds yet</Text>
        </View>
      ) : (
        <FlatList
          data={builds}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
        />
      )}
    </SafeAreaView>
  );
}

// ── Styles ──────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  emptyText: {
    fontSize: 15,
  },
  list: {
    padding: 12,
    gap: 10,
  },
  card: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
  },
  buildId: {
    fontSize: 13,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: "600",
  },
  artifactRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  artifactName: {
    fontSize: 13,
    flex: 1,
    marginRight: 8,
  },
  artifactSize: {
    fontSize: 12,
  },
  progressRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  progressBar: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 2,
  },
  progressText: {
    fontSize: 12,
    width: 36,
    textAlign: "right",
  },
  actions: {
    flexDirection: "row",
    gap: 8,
  },
  actionBtn: {
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 80,
  },
  actionText: {
    fontSize: 13,
    fontWeight: "600",
  },
});
