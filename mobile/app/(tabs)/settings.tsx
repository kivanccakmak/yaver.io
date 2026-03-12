import { router } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../src/context/AuthContext";
import { useDevice } from "../../src/context/DeviceContext";

const APP_VERSION = "1.0.0";

export default function SettingsScreen() {
  const { user, logout } = useAuth();
  const { disconnect } = useDevice();

  const handleSignOut = async () => {
    disconnect();
    await logout();
    router.replace("/login");
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={["bottom"]}>
      <View style={styles.container}>
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

        {/* App info */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>About</Text>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Version</Text>
            <Text style={styles.rowValue}>{APP_VERSION}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Build</Text>
            <Text style={styles.rowValue}>Expo SDK 52</Text>
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
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#0a0a0a" },
  container: { flex: 1, padding: 16 },
  section: { marginBottom: 32 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#52525b",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  profileCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#111118",
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
  profileName: { fontSize: 16, fontWeight: "600", color: "#e4e4e7" },
  profileEmail: { fontSize: 13, color: "#71717a", marginTop: 2 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#111118",
    borderRadius: 12,
    padding: 16,
    marginBottom: 2,
    borderWidth: 1,
    borderColor: "#1e1e2e",
  },
  rowLabel: { fontSize: 15, color: "#e4e4e7" },
  rowValue: { fontSize: 15, color: "#71717a" },
  signOutButton: {
    backgroundColor: "#ef444422",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
  },
  signOutPressed: { opacity: 0.7 },
  signOutText: { color: "#ef4444", fontSize: 16, fontWeight: "600" },
});
