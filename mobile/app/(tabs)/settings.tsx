import Constants from "expo-constants";
import { router } from "expo-router";
import React, { useState } from "react";
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../src/context/AuthContext";
import { useDevice } from "../../src/context/DeviceContext";
import { useColors, useTheme } from "../../src/context/ThemeContext";
import { clearCache } from "../../src/lib/storage";

const APP_VERSION = Constants.expoConfig?.version ?? "1.0.0";
const BUILD_NUMBER =
  Constants.expoConfig?.ios?.buildNumber ??
  Constants.expoConfig?.android?.versionCode?.toString() ??
  "1";

export default function SettingsScreen() {
  const { user, logout } = useAuth();
  const { activeDevice, connectionStatus, disconnect } = useDevice();
  const { isDark, toggleTheme } = useTheme();
  const c = useColors();
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

  const handleDeleteAccount = () => {
    Alert.alert(
      "Delete Account",
      "This will permanently delete your account, all your devices, and sessions. This action cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete Account",
          style: "destructive",
          onPress: () => {
            Alert.alert(
              "Are you sure?",
              "All your data will be permanently deleted. You will need to create a new account to use Yaver again.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Yes, Delete Everything",
                  style: "destructive",
                  onPress: async () => {
                    // TODO: Call backend to delete account
                    disconnect();
                    await logout();
                    router.replace("/login");
                  },
                },
              ]
            );
          },
        },
      ]
    );
  };

  const openLink = (url: string) => {
    Linking.openURL(url).catch(() => {});
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: c.bg }]} edges={["bottom"]}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Profile section */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: c.textMuted }]}>Account</Text>
          <View style={[styles.profileCard, { backgroundColor: c.bgCard, borderColor: c.border }]}>
            <View style={[styles.avatar, { backgroundColor: c.accent }]}>
              <Text style={[styles.avatarText, { color: c.textInverse }]}>
                {user?.name?.charAt(0).toUpperCase() ?? "?"}
              </Text>
            </View>
            <View style={styles.profileInfo}>
              <Text style={[styles.profileName, { color: c.textPrimary }]}>
                {user?.name ?? "Unknown User"}
              </Text>
              <Text style={[styles.profileEmail, { color: c.textMuted }]}>
                {user?.email ?? "No email"}
              </Text>
            </View>
          </View>
        </View>

        {/* Subscription */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: c.textMuted }]}>Subscription</Text>
          <View style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.border }]}>
            <View style={styles.subscriptionRow}>
              <View>
                <Text style={[styles.subscriptionPlan, { color: c.textPrimary }]}>Early Access</Text>
                <Text style={[styles.subscriptionMeta, { color: c.textSecondary }]}>
                  Free during early access period
                </Text>
              </View>
              <View style={[styles.freeBadge, { backgroundColor: c.successBg, borderColor: c.successBorder }]}>
                <Text style={[styles.freeBadgeText, { color: c.success }]}>FREE</Text>
              </View>
            </View>
          </View>
        </View>

        {/* Connected device */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: c.textMuted }]}>Connected Device</Text>
          {activeDevice ? (
            <View style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.border }]}>
              <View style={styles.deviceRow}>
                <View style={styles.deviceInfo}>
                  <Text style={[styles.deviceName, { color: c.textPrimary }]}>{activeDevice.name}</Text>
                  <Text style={[styles.deviceMeta, { color: c.textMuted }]}>
                    {activeDevice.os} &middot; {activeDevice.host}:{activeDevice.port}
                  </Text>
                </View>
                <View
                  style={[
                    styles.connectionDot,
                    {
                      backgroundColor:
                        connectionStatus === "connected"
                          ? c.success
                          : connectionStatus === "connecting"
                            ? c.warn
                            : connectionStatus === "error"
                              ? c.error
                              : c.textMuted,
                    },
                  ]}
                />
              </View>
              <View style={[styles.deviceDetails, { borderTopColor: c.borderSubtle }]}>
                <View style={styles.detailItem}>
                  <Text style={[styles.detailLabel, { color: c.textMuted }]}>Status</Text>
                  <Text style={[styles.detailValue, { color: c.textPrimary }]}>{connectionStatus}</Text>
                </View>
                <View style={styles.detailItem}>
                  <Text style={[styles.detailLabel, { color: c.textMuted }]}>Last seen</Text>
                  <Text style={[styles.detailValue, { color: c.textPrimary }]}>
                    {activeDevice.online
                      ? "Online now"
                      : new Date(activeDevice.lastSeen).toLocaleString()}
                  </Text>
                </View>
              </View>
            </View>
          ) : (
            <View style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.border }]}>
              <Text style={[styles.noDeviceText, { color: c.textMuted }]}>
                No device connected. Go to the Devices tab to connect.
              </Text>
            </View>
          )}
        </View>

        {/* Appearance */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: c.textMuted }]}>Appearance</Text>
          <View style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.border }]}>
            <View style={styles.themeRow}>
              <Text style={[styles.themeLabel, { color: c.textPrimary }]}>Dark Mode</Text>
              <Switch
                value={isDark}
                onValueChange={toggleTheme}
                trackColor={{ false: c.border, true: c.accent }}
                thumbColor="#ffffff"
              />
            </View>
          </View>
        </View>

        {/* Data management */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: c.textMuted }]}>Data</Text>
          <Pressable
            style={({ pressed }) => [
              styles.actionRow,
              { backgroundColor: c.bgCard, borderColor: c.border },
              pressed && styles.actionRowPressed,
            ]}
            onPress={handleClearCache}
            disabled={isClearing}
          >
            <Text style={[styles.actionRowLabel, { color: c.textPrimary }]}>
              {isClearing ? "Clearing..." : "Clear Task Cache"}
            </Text>
            <Text style={[styles.actionRowChevron, { color: c.textMuted }]}>&rsaquo;</Text>
          </Pressable>
        </View>

        {/* About */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: c.textMuted }]}>About</Text>
          <View style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.border }]}>
            <View style={styles.aboutRow}>
              <Text style={[styles.aboutLabel, { color: c.textPrimary }]}>Version</Text>
              <Text style={[styles.aboutValue, { color: c.textMuted }]}>{APP_VERSION}</Text>
            </View>
            <View style={[styles.separator, { backgroundColor: c.borderSubtle }]} />
            <View style={styles.aboutRow}>
              <Text style={[styles.aboutLabel, { color: c.textPrimary }]}>Build</Text>
              <Text style={[styles.aboutValue, { color: c.textMuted }]}>{BUILD_NUMBER}</Text>
            </View>
          </View>

          <View style={[styles.linksCard, { backgroundColor: c.bgCard, borderColor: c.border }]}>
            {[
              { label: "Website", url: "https://yaver.io" },
              { label: "Privacy Policy", url: "https://yaver.io/privacy" },
              { label: "Terms of Service", url: "https://yaver.io/terms" },
              { label: "Contact", url: "mailto:support@yaver.io" },
            ].map((link, i) => (
              <React.Fragment key={link.label}>
                {i > 0 && <View style={[styles.separator, { backgroundColor: c.borderSubtle }]} />}
                <Pressable
                  style={({ pressed }) => [
                    styles.linkRow,
                    pressed && { backgroundColor: c.bgCardElevated },
                  ]}
                  onPress={() => openLink(link.url)}
                >
                  <Text style={[styles.linkText, { color: c.accent }]}>{link.label}</Text>
                  <Text style={[styles.linkChevron, { color: c.textMuted }]}>&rsaquo;</Text>
                </Pressable>
              </React.Fragment>
            ))}
          </View>
        </View>

        {/* Sign out */}
        <View style={styles.section}>
          <Pressable
            style={({ pressed }) => [
              styles.signOutButton,
              { backgroundColor: c.errorBg },
              pressed && styles.signOutPressed,
            ]}
            onPress={handleSignOut}
          >
            <Text style={[styles.signOutText, { color: c.error }]}>Sign Out</Text>
          </Pressable>
        </View>

        {/* Delete account */}
        <View style={styles.section}>
          <Pressable
            style={({ pressed }) => [
              styles.deleteAccountButton,
              pressed && styles.deleteAccountPressed,
            ]}
            onPress={handleDeleteAccount}
          >
            <Text style={styles.deleteAccountText}>Delete Account</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  container: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 40 },

  section: { marginBottom: 32 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 12,
  },

  profileCard: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },
  avatarText: { fontSize: 20, fontWeight: "700" },
  profileInfo: { flex: 1 },
  profileName: { fontSize: 16, fontWeight: "600" },
  profileEmail: { fontSize: 13, marginTop: 2 },

  // Subscription
  subscriptionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  subscriptionPlan: { fontSize: 16, fontWeight: "600" },
  subscriptionMeta: { fontSize: 13, marginTop: 2 },
  freeBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  freeBadgeText: { fontSize: 12, fontWeight: "700" },

  card: {
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    marginBottom: 8,
  },

  // Device
  deviceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  deviceInfo: { flex: 1 },
  deviceName: { fontSize: 16, fontWeight: "600" },
  deviceMeta: { fontSize: 12, marginTop: 2 },
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
    gap: 24,
  },
  detailItem: {},
  detailLabel: { fontSize: 11, marginBottom: 2 },
  detailValue: { fontSize: 13 },
  noDeviceText: { fontSize: 14 },

  // Theme
  themeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  themeLabel: { fontSize: 15 },

  // Action row
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
  },
  actionRowPressed: { opacity: 0.7 },
  actionRowLabel: { fontSize: 15 },
  actionRowChevron: { fontSize: 20 },

  // About
  aboutRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 4,
  },
  aboutLabel: { fontSize: 15 },
  aboutValue: { fontSize: 15 },

  // Links
  linksCard: {
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
  },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
  },
  linkText: { fontSize: 15 },
  linkChevron: { fontSize: 20 },

  separator: {
    height: 1,
    marginHorizontal: 16,
  },

  signOutButton: {
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
  },
  signOutPressed: { opacity: 0.7 },
  signOutText: { fontSize: 16, fontWeight: "600" },

  deleteAccountButton: {
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
  },
  deleteAccountPressed: { opacity: 0.7 },
  deleteAccountText: { color: "#888", fontSize: 14 },
});
