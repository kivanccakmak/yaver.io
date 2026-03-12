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

function ConnectionBadge({ status }: { status: string }) {
  const color =
    status === "connected"
      ? "#22c55e"
      : status === "connecting"
        ? "#eab308"
        : status === "error"
          ? "#ef4444"
          : "#52525b";
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
        isActive && styles.cardActive,
        pressed && styles.cardPressed,
      ]}
      onPress={onSelect}
    >
      <View style={styles.cardRow}>
        <View style={styles.cardInfo}>
          <Text style={styles.deviceName}>{device.name}</Text>
          <Text style={styles.deviceMeta}>
            {device.os} &middot; {device.host}:{device.port}
          </Text>
        </View>
        <View style={styles.cardRight}>
          <View
            style={[
              styles.onlineDot,
              { backgroundColor: device.online ? "#22c55e" : "#52525b" },
            ]}
          />
          <Text style={styles.lastSeen}>
            {device.online ? "online" : timeSince(device.lastSeen)}
          </Text>
        </View>
      </View>
      {isActive && (
        <View style={styles.activeLabel}>
          <Text style={styles.activeLabelText}>Active</Text>
        </View>
      )}
    </Pressable>
  );
}

export default function DevicesScreen() {
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
    <SafeAreaView style={styles.safeArea} edges={["bottom"]}>
      <View style={styles.container}>
        {/* Connection status */}
        {activeDevice && (
          <View style={styles.statusBar}>
            <ConnectionBadge status={connectionStatus} />
            {connectionStatus === "connected" && (
              <Pressable style={styles.disconnectBtn} onPress={disconnect}>
                <Text style={styles.disconnectText}>Disconnect</Text>
              </Pressable>
            )}
          </View>
        )}

        {/* Device list */}
        {isLoadingDevices ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color="#6366f1" />
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
                <Text style={styles.emptyTitle}>No Devices Found</Text>
                <Text style={styles.emptySubtitle}>
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
  safeArea: { flex: 1, backgroundColor: "#0a0a0a" },
  container: { flex: 1 },
  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1e1e2e",
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
    backgroundColor: "#1e1e2e",
  },
  disconnectText: { color: "#ef4444", fontSize: 13, fontWeight: "600" },
  listContent: { padding: 16, flexGrow: 1 },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: "#e4e4e7" },
  emptySubtitle: {
    fontSize: 14,
    color: "#71717a",
    textAlign: "center",
    marginTop: 8,
  },
  card: {
    backgroundColor: "#111118",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#1e1e2e",
  },
  cardActive: { borderColor: "#6366f1" },
  cardPressed: { opacity: 0.7 },
  cardRow: { flexDirection: "row", justifyContent: "space-between" },
  cardInfo: { flex: 1, marginRight: 12 },
  deviceName: { fontSize: 16, fontWeight: "600", color: "#e4e4e7" },
  deviceMeta: { fontSize: 13, color: "#71717a", marginTop: 4 },
  cardRight: { alignItems: "flex-end" },
  onlineDot: { width: 8, height: 8, borderRadius: 4, marginBottom: 4 },
  lastSeen: { fontSize: 11, color: "#52525b" },
  activeLabel: {
    marginTop: 10,
    alignSelf: "flex-start",
    backgroundColor: "#6366f122",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  activeLabelText: { color: "#6366f1", fontSize: 12, fontWeight: "600" },
});
