import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useDevice } from "../../src/context/DeviceContext";
import { useColors } from "../../src/context/ThemeContext";
import { quicClient } from "../../src/lib/quic";
import { setPendingVibingProject } from "../../src/lib/vibingStore";

type Project = { name: string; path: string; branch?: string };

export default function ProjectsScreen() {
  const c = useColors();
  const { activeDevice, connectionStatus } = useDevice();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!activeDevice || connectionStatus !== "connected") {
      setProjects([]);
      return;
    }
    setLoading(true);
    try {
      setProjects(await quicClient.listProjects(true));
    } catch {
      // keep previous list
    } finally {
      setLoading(false);
    }
  }, [activeDevice, connectionStatus]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.bg }]} edges={["bottom"]}>
      <ScrollView
        contentContainerStyle={styles.container}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={load} tintColor={c.accent} />
        }
      >
        <View style={styles.headerRow}>
          <View style={styles.titleBlock}>
            <Text style={[styles.title, { color: c.textPrimary }]}>Projects</Text>
            <Text style={[styles.subtitle, { color: c.textSecondary }]}>
              {activeDevice ? `Repositories on ${activeDevice.name}` : "Connect a device to list projects"}
            </Text>
          </View>
        </View>

        {loading && projects.length === 0 ? (
          <ActivityIndicator style={{ marginTop: 32 }} size="large" color={c.accent} />
        ) : projects.length === 0 ? (
          <Text style={[styles.empty, { color: c.textMuted }]}>
            {activeDevice
              ? "No projects discovered yet. Run 'yaver discover' on the device."
              : "Connect a device to see its projects."}
          </Text>
        ) : (
          projects.map((p) => (
            <Pressable
              key={p.path}
              style={({ focused }) => [styles.card, { backgroundColor: c.bgCard, borderColor: c.border }, focused && styles.focused]}
              onPress={() => {
                quicClient.setWorkDir(p.path).catch(() => {});
                setPendingVibingProject(p.path);
                router.push("/vibing");
              }}
            >
              <Text style={styles.cardIcon}>📁</Text>
              <View style={{ flex: 1 }}>
                <Text style={[styles.cardName, { color: c.textPrimary }]} numberOfLines={1}>{p.name}</Text>
                <Text style={[styles.cardPath, { color: c.textSecondary }]} numberOfLines={1}>{p.path}</Text>
              </View>
              {p.branch ? <Text style={[styles.cardBranch, { color: c.accent }]}>{p.branch}</Text> : null}
            </Pressable>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { padding: 48, paddingBottom: 80 },
  headerRow: { marginBottom: 28 },
  titleBlock: {},
  title: { fontSize: 48, fontWeight: "800" },
  subtitle: { fontSize: 20, marginTop: 4 },
  empty: { fontSize: 18, marginTop: 8 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 16,
    borderWidth: 2,
    padding: 22,
    marginBottom: 14,
    gap: 16,
  },
  cardIcon: { fontSize: 32 },
  cardName: { fontSize: 26, fontWeight: "700" },
  cardPath: { fontSize: 16, marginTop: 4 },
  cardBranch: { fontSize: 16, fontWeight: "600" },
  focused: { transform: [{ scale: 1.02 }], opacity: 0.92 },
});
