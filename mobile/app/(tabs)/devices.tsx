import React from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
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
            ListEmptyComponent={
              <View style={styles.center}>
                <Text style={[styles.emptyTitle, { color: c.textPrimary }]}>No Devices Found</Text>
                <Text style={[styles.emptySubtitle, { color: c.textSecondary }]}>
                  Start the Yaver desktop agent on your computer to see it here.
                </Text>
              </View>
            }
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
  emptyTitle: { fontSize: 18, fontWeight: "700" },
  emptySubtitle: {
    fontSize: 14,
    textAlign: "center",
    marginTop: 8,
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
