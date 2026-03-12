import { router } from "expo-router";
import React, { useState } from "react";
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../src/context/AuthContext";
import { useDevice } from "../../src/context/DeviceContext";
import { clearCache } from "../../src/lib/storage";

const APP_VERSION = "1.0.0";
const BUILD_INFO = "Expo SDK 52";

export default function SettingsScreen() {
  const { user, logout } = useAuth();
  const { activeDevice, connectionStatus, disconnect } = useDevice();
  const [isClearing, setIsClearing] = useState(false);

  const handleSignOut = async () => {
    disconnect();
    await logout();
    router.replace("/login");
  };

  const handleClearCache = () => {
    Alert.alert(
      "Clear Task Cache",
      "This will remove all locally cached tasks and output. Data will be re-fetched from your device on next sync.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: async () => {
            setIsClearing(true);
            try {
              await clearCache();
              Alert.alert("Done", "Task cache has been cleared.");
            } catch {
              Alert.alert("Error", "Failed to clear cache.");
            } finally {
              setIsClearing(false);
            }
          },
        },
      ]
    );
  };

  const openLink = (url: string) => {
    Linking.openURL(url).catch(() => {
      // Silently fail if link cannot be opened.
    });
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={["bottom"]}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Profile section */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Account</Text>
          <View style={styles.profileCard}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {user?.name?.charAt(0).toUpperCase() ?? "?"}
              </Text>
            </View>
            <View style={styles.profileInfo}>
              <Text style={styles.profileName}>
                {user?.name ?? "Unknown User"}
              </Text>
              <Text style={styles.profileEmail}>
                {user?.email ?? "No email"}
              </Text>
            </View>
          </View>
        </View>

        {/* Connected device */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Connected Device</Text>
          {activeDevice ? (
            <View style={styles.card}>
              <View style={styles.deviceRow}>
                <View style={styles.deviceInfo}>
                  <Text style={styles.deviceName}>{activeDevice.name}</Text>
                  <Text style={styles.deviceMeta}>
                    {activeDevice.os} &middot; {activeDevice.host}:
                    {activeDevice.port}
                  </Text>
                </View>
                <View
                  style={[
                    styles.connectionDot,
                    {
                      backgroundColor:
                        connectionStatus === "connected"
                          ? "#22c55e"
                          : connectionStatus === "connecting"
                            ? "#eab308"
                            : connectionStatus === "error"
                              ? "#ef4444"
                              : "#666",
                    },
                  ]}
                />
              </View>
              <View style={styles.deviceDetails}>
                <View style={styles.detailItem}>
                  <Text style={styles.detailLabel}>Status</Text>
                  <Text style={styles.detailValue}>{connectionStatus}</Text>
                </View>
                <View style={styles.detailItem}>
                  <Text style={styles.detailLabel}>Last seen</Text>
                  <Text style={styles.detailValue}>
                    {activeDevice.online
                      ? "Online now"
                      : new Date(activeDevice.lastSeen).toLocaleString()}
                  </Text>
                </View>
              </View>
            </View>
          ) : (
            <View style={styles.card}>
              <Text style={styles.noDeviceText}>
                No device connected. Go to the Devices tab to connect.
              </Text>
            </View>
          )}
        </View>

        {/* Data management */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Data</Text>
          <Pressable
            style={({ pressed }) => [
              styles.actionRow,
              pressed && styles.actionRowPressed,
            ]}
            onPress={handleClearCache}
            disabled={isClearing}
          >
            <Text style={styles.actionRowLabel}>
              {isClearing ? "Clearing..." : "Clear Task Cache"}
            </Text>
            <Text style={styles.actionRowChevron}>&rsaquo;</Text>
          </Pressable>
        </View>

        {/* About */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>About</Text>
          <View style={styles.card}>
            <View style={styles.aboutRow}>
              <Text style={styles.aboutLabel}>Version</Text>
              <Text style={styles.aboutValue}>{APP_VERSION}</Text>
            </View>
            <View style={styles.separator} />
            <View style={styles.aboutRow}>
              <Text style={styles.aboutLabel}>Build</Text>
              <Text style={styles.aboutValue}>{BUILD_INFO}</Text>
            </View>
          </View>

          <View style={styles.linksCard}>
            <Pressable
              style={({ pressed }) => [
                styles.linkRow,
                pressed && styles.linkRowPressed,
              ]}
              onPress={() => openLink("https://yaver.io")}
            >
              <Text style={styles.linkText}>Website</Text>
              <Text style={styles.linkChevron}>&rsaquo;</Text>
            </Pressable>
            <View style={styles.separator} />
            <Pressable
              style={({ pressed }) => [
                styles.linkRow,
                pressed && styles.linkRowPressed,
              ]}
              onPress={() => openLink("https://yaver.io/privacy")}
            >
              <Text style={styles.linkText}>Privacy Policy</Text>
              <Text style={styles.linkChevron}>&rsaquo;</Text>
            </Pressable>
            <View style={styles.separator} />
            <Pressable
              style={({ pressed }) => [
                styles.linkRow,
                pressed && styles.linkRowPressed,
              ]}
              onPress={() => openLink("https://yaver.io/terms")}
            >
              <Text style={styles.linkText}>Terms of Service</Text>
              <Text style={styles.linkChevron}>&rsaquo;</Text>
            </Pressable>
            <View style={styles.separator} />
            <Pressable
              style={({ pressed }) => [
                styles.linkRow,
                pressed && styles.linkRowPressed,
              ]}
              onPress={() =>
                openLink("https://github.com/yaver-io/yaver")
              }
            >
              <Text style={styles.linkText}>GitHub</Text>
              <Text style={styles.linkChevron}>&rsaquo;</Text>
            </Pressable>
          </View>
        </View>

        {/* Sign out */}
        <View style={styles.section}>
          <Pressable
            style={({ pressed }) => [
              styles.signOutButton,
              pressed && styles.signOutPressed,
            ]}
            onPress={handleSignOut}
          >
            <Text style={styles.signOutText}>Sign Out</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#0a0a0a" },
  container: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 40 },

  section: { marginBottom: 32 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#666",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 12,
  },

  // Profile
  profileCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#111",
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: "#1e1e2e",
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#6366f1",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },
  avatarText: { fontSize: 20, fontWeight: "700", color: "#ffffff" },
  profileInfo: { flex: 1 },
  profileName: { fontSize: 16, fontWeight: "600", color: "#d0d0d0" },
  profileEmail: { fontSize: 13, color: "#666", marginTop: 2 },

  // Card
  card: {
    backgroundColor: "#111",
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: "#1e1e2e",
    marginBottom: 8,
  },

  // Device
  deviceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  deviceInfo: { flex: 1 },
  deviceName: { fontSize: 16, fontWeight: "600", color: "#d0d0d0" },
  deviceMeta: { fontSize: 12, color: "#666", marginTop: 2 },
  connectionDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginLeft: 12,
  },
  deviceDetails: {
    flexDirection: "row",
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: "#1e1e2e",
    gap: 24,
  },
  detailItem: {},
  detailLabel: { fontSize: 11, color: "#666", marginBottom: 2 },
  detailValue: { fontSize: 13, color: "#d0d0d0" },
  noDeviceText: { fontSize: 14, color: "#666" },

  // Action row
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#111",
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: "#1e1e2e",
  },
  actionRowPressed: { opacity: 0.7 },
  actionRowLabel: { fontSize: 15, color: "#d0d0d0" },
  actionRowChevron: { fontSize: 20, color: "#666" },

  // About
  aboutRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 4,
  },
  aboutLabel: { fontSize: 15, color: "#d0d0d0" },
  aboutValue: { fontSize: 15, color: "#666" },

  // Links
  linksCard: {
    backgroundColor: "#111",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#1e1e2e",
    overflow: "hidden",
  },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
  },
  linkRowPressed: { backgroundColor: "#1a1a1a" },
  linkText: { fontSize: 15, color: "#6366f1" },
  linkChevron: { fontSize: 20, color: "#666" },

  separator: {
    height: 1,
    backgroundColor: "#1e1e2e",
    marginHorizontal: 16,
  },

  // Sign out
  signOutButton: {
    backgroundColor: "#ef444422",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
  },
  signOutPressed: { opacity: 0.7 },
  signOutText: { color: "#ef4444", fontSize: 16, fontWeight: "600" },
});
