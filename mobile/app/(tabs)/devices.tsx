import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { SafeAreaView } from "react-native-safe-area-context";
import { Device, useDevice } from "../../src/context/DeviceContext";
import { useColors } from "../../src/context/ThemeContext";

function ConnectionBadge({ status }: { status: string }) {
  const c = useColors();
  const color =
    status === "connected" ? c.success
    : status === "connecting" ? c.warn
    : status === "error" ? c.error
    : c.textMuted;
  return (
    <View style={[styles.connBadge, { backgroundColor: color + "22" }]}>
      <View style={[styles.connDot, { backgroundColor: color }]} />
      <Text style={[styles.connText, { color }]}>{status}</Text>
    </View>
  );
}

function DeviceCard({
  device,
  isActive,
  onSelect,
}: {
  device: Device;
  isActive: boolean;
  onSelect: () => void;
}) {
  const c = useColors();
  const timeSince = (ts: number) => {
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  return (
    <Pressable
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: c.bgCard, borderColor: isActive ? c.accent : c.border },
        pressed && styles.cardPressed,
      ]}
      onPress={onSelect}
    >
      <View style={styles.cardRow}>
        <View style={styles.cardInfo}>
          <Text style={[styles.deviceName, { color: c.textPrimary }]}>{device.name}</Text>
          <Text style={[styles.deviceMeta, { color: c.textMuted }]}>
            {device.os} &middot; {device.host}:{device.port}
          </Text>
        </View>
        <View style={styles.cardRight}>
          <View
            style={[
              styles.onlineDot,
              { backgroundColor: device.online ? c.success : c.textMuted },
            ]}
          />
          <Text style={[styles.lastSeen, { color: c.textMuted }]}>
            {device.online ? "online" : timeSince(device.lastSeen)}
          </Text>
        </View>
      </View>
      {isActive && (
        <View style={[styles.activeLabel, { backgroundColor: c.accent + "22" }]}>
          <Text style={[styles.activeLabelText, { color: c.accent }]}>Active</Text>
        </View>
      )}
    </Pressable>
  );
}

function CopyableCommand({ command }: { command: string }) {
  const c = useColors();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [command]);

  return (
    <Pressable
      style={[styles.codeBlock, { backgroundColor: c.bg }]}
      onPress={handleCopy}
    >
      <Text style={[styles.codeText, { color: c.textPrimary }]}>{command}</Text>
      <Text style={[styles.copyHint, { color: copied ? c.success : c.textMuted }]}>
        {copied ? "Copied!" : "Tap to copy"}
      </Text>
    </Pressable>
  );
}

function PlatformIcon({ platform }: { platform: string }) {
  const labels: Record<string, string> = { mac: "⌘", linux: "🐧", windows: "⊞" };
  return <Text style={{ fontSize: 16, marginRight: 6 }}>{labels[platform] || ""}</Text>;
}

function PlatformTab({
  platform,
  label,
  active,
  onPress,
}: {
  platform: string;
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      style={[
        styles.platformTab,
        {
          backgroundColor: active ? c.textPrimary + "12" : "transparent",
          borderColor: active ? c.textPrimary : c.border,
        },
      ]}
      onPress={onPress}
    >
      <PlatformIcon platform={platform} color={active ? c.textPrimary : c.textMuted} />
      <Text style={[styles.platformTabText, { color: active ? c.textPrimary : c.textMuted }]}>
        {label}
      </Text>
    </Pressable>
  );
}

function SetupInstructions() {
  const c = useColors();
  const [platform, setPlatform] = useState<"mac" | "linux" | "windows">("mac");

  return (
    <ScrollView contentContainerStyle={styles.setupContainer}>
      <Text style={[styles.emptyTitle, { color: c.textPrimary }]}>Set Up Your Desktop</Text>
      <Text style={[styles.emptySubtitle, { color: c.textSecondary }]}>
        Install the Yaver agent on your dev machine, then pull to refresh.
      </Text>

      <View style={styles.platformTabs}>
        <PlatformTab platform="mac" label="macOS" active={platform === "mac"} onPress={() => setPlatform("mac")} />
        <PlatformTab platform="linux" label="Linux" active={platform === "linux"} onPress={() => setPlatform("linux")} />
        <PlatformTab platform="windows" label="Windows" active={platform === "windows"} onPress={() => setPlatform("windows")} />
      </View>

      {platform === "mac" && (
        <View style={styles.steps}>
          <Text style={[styles.stepLabel, { color: c.textSecondary }]}>1. Install via Homebrew</Text>
          <CopyableCommand command="brew tap kivanccakmak/yaver && brew install yaver" />

          <Text style={[styles.stepLabel, { color: c.textSecondary }]}>2. Sign in & start</Text>
          <CopyableCommand command="yaver auth" />
        </View>
      )}

      {platform === "linux" && (
        <View style={styles.steps}>
          <Text style={[styles.stepLabel, { color: c.textSecondary }]}>1. Install via Homebrew</Text>
          <CopyableCommand command="brew tap kivanccakmak/yaver && brew install yaver" />

          <Text style={[styles.stepLabel, { color: c.textSecondary }]}>Or download directly</Text>
          <CopyableCommand command={'curl -fsSL https://github.com/kivanccakmak/yaver-cli/releases/latest/download/yaver-linux-amd64 -o yaver && chmod +x yaver && sudo mv yaver /usr/local/bin/'} />

          <Text style={[styles.stepLabel, { color: c.textSecondary }]}>2. Sign in & start</Text>
          <CopyableCommand command="yaver auth" />
        </View>
      )}

      {platform === "windows" && (
        <View style={styles.steps}>
          <Text style={[styles.stepLabel, { color: c.textSecondary }]}>1. Install via Scoop (PowerShell)</Text>
          <CopyableCommand command="scoop bucket add yaver https://github.com/kivanccakmak/scoop-yaver && scoop install yaver" />

          <Text style={[styles.stepLabel, { color: c.textSecondary }]}>Or download manually</Text>
          <Text style={[styles.stepHint, { color: c.textMuted }]}>
            Download from yaver.io/download and add to your PATH.
          </Text>

          <Text style={[styles.stepLabel, { color: c.textSecondary }]}>2. Sign in & start</Text>
          <CopyableCommand command="yaver auth" />
        </View>
      )}

      <Text style={[styles.refreshHint, { color: c.textMuted }]}>
        Pull down to refresh after setup
      </Text>
    </ScrollView>
  );
}

export default function DevicesScreen() {
  const c = useColors();
  const {
    devices,
    activeDevice,
    connectionStatus,
    isLoadingDevices,
    selectDevice,
    disconnect,
    refreshDevices,
  } = useDevice();

  // Auto-refresh every 10 seconds
  useEffect(() => {
    const interval = setInterval(refreshDevices, 10000);
    return () => clearInterval(interval);
  }, [refreshDevices]);

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: c.bg }]} edges={["bottom"]}>
      <View style={styles.container}>
        {activeDevice && (
          <View style={[styles.statusBar, { borderBottomColor: c.border }]}>
            <ConnectionBadge status={connectionStatus} />
            {connectionStatus === "connected" && (
              <Pressable style={[styles.disconnectBtn, { backgroundColor: c.bgCardElevated }]} onPress={disconnect}>
                <Text style={[styles.disconnectText, { color: c.error }]}>Disconnect</Text>
              </Pressable>
            )}
          </View>
        )}

        {isLoadingDevices ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={c.accent} />
          </View>
        ) : (
          <FlatList
            data={devices}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.listContent}
            refreshing={isLoadingDevices}
            onRefresh={refreshDevices}
            ListEmptyComponent={<SetupInstructions />}
            renderItem={({ item }) => (
              <DeviceCard
                device={item}
                isActive={activeDevice?.id === item.id}
                onSelect={() => selectDevice(item)}
              />
            )}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  container: { flex: 1 },
  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  connBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  connDot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
  connText: { fontSize: 12, fontWeight: "600", textTransform: "capitalize" },
  disconnectBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  disconnectText: { fontSize: 13, fontWeight: "600" },
  listContent: { padding: 16, flexGrow: 1 },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  emptyTitle: { fontSize: 20, fontWeight: "700", textAlign: "center" },
  emptySubtitle: {
    fontSize: 14,
    textAlign: "center",
    marginTop: 8,
    lineHeight: 20,
  },
  setupContainer: {
    padding: 8,
    paddingTop: 24,
    alignItems: "center",
  },
  platformTabs: {
    flexDirection: "row",
    gap: 8,
    marginTop: 20,
    marginBottom: 20,
  },
  platformTab: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  platformTabText: {
    fontSize: 13,
    fontWeight: "600",
  },
  steps: {
    width: "100%",
    gap: 6,
  },
  stepLabel: {
    fontSize: 13,
    fontWeight: "600",
    marginTop: 10,
    marginBottom: 2,
  },
  stepHint: {
    fontSize: 12,
    marginTop: 4,
    lineHeight: 18,
  },
  codeBlock: {
    width: "100%",
    borderRadius: 8,
    padding: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  codeText: {
    fontSize: 12,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    flex: 1,
    marginRight: 8,
  },
  copyHint: {
    fontSize: 10,
    flexShrink: 0,
  },
  refreshHint: {
    fontSize: 12,
    marginTop: 24,
    textAlign: "center",
  },
  card: {
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
  },
  cardPressed: { opacity: 0.7 },
  cardRow: { flexDirection: "row", justifyContent: "space-between" },
  cardInfo: { flex: 1, marginRight: 12 },
  deviceName: { fontSize: 16, fontWeight: "600" },
  deviceMeta: { fontSize: 13, marginTop: 4 },
  cardRight: { alignItems: "flex-end" },
  onlineDot: { width: 8, height: 8, borderRadius: 4, marginBottom: 4 },
  lastSeen: { fontSize: 11 },
  activeLabel: {
    marginTop: 10,
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  activeLabelText: { fontSize: 12, fontWeight: "600" },
});
