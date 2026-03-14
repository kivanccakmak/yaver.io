import Constants from "expo-constants";
import { router } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../src/context/AuthContext";
import { useDevice } from "../../src/context/DeviceContext";
import { useColors, useTheme } from "../../src/context/ThemeContext";
import { deleteAccount as deleteAccountApi, updateProfile, getUserSettings, saveUserSettings } from "../../src/lib/auth";
import { clearCache } from "../../src/lib/storage";
import * as ExpoClipboard from "expo-clipboard";
import { getLogEntries, clearLogEntries, onLogsChanged, LogEntry } from "../../src/lib/logger";
import { quicClient } from "../../src/lib/quic";
import {
  type SubscriptionStatus,
  getSubscriptionStatus,
  getCustomerPortal,
} from "../../src/lib/subscription";

const APP_VERSION = Constants.expoConfig?.version ?? "1.0.0";
const BUILD_NUMBER =
  Constants.expoConfig?.ios?.buildNumber ??
  Constants.expoConfig?.android?.versionCode?.toString() ??
  "1";

export default function SettingsScreen() {
  const { user, token, logout, surveyCompleted, refreshUser } = useAuth();
  const { activeDevice, connectionStatus, disconnect } = useDevice();
  const { isDark, toggleTheme } = useTheme();
  const c = useColors();
  // Name is "empty" if it equals the email or is blank
  const displayName = user?.name && user.name !== user.email ? user.name : null;
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState(user?.name ?? "");
  const [isSavingName, setIsSavingName] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [subscription, setSubscription] = useState<SubscriptionStatus | null>(null);
  const [isLoadingSubscription, setIsLoadingSubscription] = useState(true);
  const [isOpeningPortal, setIsOpeningPortal] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>(getLogEntries());
  const [forceRelay, setForceRelay] = useState(quicClient.forceRelay);

  // Load user settings from Convex
  useEffect(() => {
    if (!token) return;
    getUserSettings(token).then((s) => {
      if (s.forceRelay !== undefined) {
        setForceRelay(s.forceRelay);
        quicClient.setForceRelay(s.forceRelay);
      }
    });
  }, [token]);

  // Subscribe to live log updates
  useEffect(() => {
    return onLogsChanged(() => setLogs(getLogEntries()));
  }, []);

  const fetchSubscription = useCallback(async () => {
    if (!token) {
      setIsLoadingSubscription(false);
      return;
    }
    try {
      const status = await getSubscriptionStatus(token);
      setSubscription(status);
    } catch {
      setSubscription({ plan: "Early Access", status: "active" });
    } finally {
      setIsLoadingSubscription(false);
    }
  }, [token]);

  useEffect(() => {
    fetchSubscription();
  }, [fetchSubscription]);

  const handleManageSubscription = async () => {
    if (!token) return;
    setIsOpeningPortal(true);
    try {
      const portalUrl = await getCustomerPortal(token);
      if (portalUrl) {
        await Linking.openURL(portalUrl);
      } else {
        Alert.alert("Unavailable", "Subscription management is not available yet.");
      }
    } catch {
      Alert.alert("Error", "Could not open subscription management.");
    } finally {
      setIsOpeningPortal(false);
    }
  };

  const isEarlyAccess = !subscription || subscription.plan === "Early Access" || subscription.plan === "early_access";

  const handleSaveName = async () => {
    if (!token || !editName.trim()) return;
    setIsSavingName(true);
    try {
      await updateProfile(token, { fullName: editName.trim() });
      await refreshUser();
      setIsEditingName(false);
    } catch {
      Alert.alert("Error", "Failed to update name.");
    } finally {
      setIsSavingName(false);
    }
  };

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

  const handleDeleteAccount = async () => {
    if (deleteConfirm !== "delete my account") return;
    setDeletingAccount(true);
    const success = await deleteAccountApi();
    if (success) {
      disconnect();
      await logout();
      router.replace("/login");
    } else {
      Alert.alert("Error", "Failed to delete account. Please try again.");
      setDeletingAccount(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: c.bg }]} edges={["bottom"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 120 : 0}
      >
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Profile section */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: c.textMuted }]}>Account</Text>
          <View style={[styles.profileCard, { backgroundColor: c.bgCard, borderColor: c.border }]}>
            <View style={[styles.avatar, { backgroundColor: c.accent }]}>
              <Text style={[styles.avatarText, { color: c.textInverse }]}>
                {displayName ? displayName.charAt(0).toUpperCase() : "?"}
              </Text>
            </View>
            <View style={styles.profileInfo}>
              {isEditingName ? (
                <View style={styles.editNameRow}>
                  <TextInput
                    style={[styles.editNameInput, { backgroundColor: c.bgCardElevated, borderColor: c.border, color: c.textPrimary }]}
                    value={editName}
                    onChangeText={setEditName}
                    autoCapitalize="words"
                    autoFocus
                  />
                  <Pressable
                    style={[styles.editNameButton, { backgroundColor: c.accent }]}
                    onPress={handleSaveName}
                    disabled={isSavingName}
                  >
                    <Text style={styles.editNameButtonText}>{isSavingName ? "..." : "Save"}</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable onPress={() => { setEditName(displayName ?? ""); setIsEditingName(true); }}>
                  <Text style={[styles.profileName, { color: displayName ? c.textPrimary : c.textMuted }]}>
                    {displayName || "Set your name"}
                  </Text>
                </Pressable>
              )}
              <Text style={[styles.profileEmail, { color: c.textMuted }]}>
                {user?.email ?? "No email"}
              </Text>
            </View>
          </View>
        </View>

        {/* Developer Profile — only show if survey not completed */}
        {!surveyCompleted && (
          <View style={styles.section}>
            <Text style={[styles.sectionLabel, { color: c.textMuted }]}>Developer Profile</Text>
            <Pressable
              style={({ pressed }) => [
                styles.actionRow,
                { backgroundColor: c.bgCard, borderColor: c.border },
                pressed && styles.actionRowPressed,
              ]}
              onPress={() => router.push("/survey")}
            >
              <Text style={[styles.actionRowLabel, { color: c.textPrimary }]}>
                Complete Developer Survey
              </Text>
              <Text style={[styles.actionRowChevron, { color: c.textMuted }]}>&rsaquo;</Text>
            </Pressable>
          </View>
        )}

        {/* Subscription */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: c.textMuted }]}>Subscription</Text>
          <View style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.border }]}>
            {isLoadingSubscription ? (
              <View style={styles.subscriptionLoading}>
                <ActivityIndicator size="small" color={c.accent} />
              </View>
            ) : (
              <>
                <View style={styles.subscriptionRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.subscriptionPlan, { color: c.textPrimary }]}>
                      {isEarlyAccess ? "Early Access" : subscription?.plan ?? "Early Access"}
                    </Text>
                    <Text style={[styles.subscriptionMeta, { color: c.textSecondary }]}>
                      {isEarlyAccess
                        ? "Free during early access period"
                        : `Status: ${subscription?.status ?? "active"}`}
                    </Text>
                    {!isEarlyAccess && subscription?.renewalDate && (
                      <Text style={[styles.subscriptionMeta, { color: c.textMuted, marginTop: 2 }]}>
                        Renews {new Date(subscription.renewalDate).toLocaleDateString()}
                      </Text>
                    )}
                  </View>
                  {isEarlyAccess ? (
                    <View style={[styles.freeBadge, { backgroundColor: c.successBg, borderColor: c.successBorder }]}>
                      <Text style={[styles.freeBadgeText, { color: c.success }]}>FREE</Text>
                    </View>
                  ) : (
                    <View style={[styles.statusBadge, {
                      backgroundColor: subscription?.status === "active" ? c.successBg : c.errorBg,
                      borderColor: subscription?.status === "active" ? c.successBorder : c.error,
                    }]}>
                      <Text style={[styles.freeBadgeText, {
                        color: subscription?.status === "active" ? c.success : c.error,
                      }]}>
                        {(subscription?.status ?? "active").toUpperCase()}
                      </Text>
                    </View>
                  )}
                </View>
                {!isEarlyAccess && (
                  <Pressable
                    style={({ pressed }) => [
                      styles.manageButton,
                      { borderColor: c.border },
                      pressed && { opacity: 0.7 },
                    ]}
                    onPress={handleManageSubscription}
                    disabled={isOpeningPortal}
                  >
                    <Text style={[styles.manageButtonText, { color: c.accent }]}>
                      {isOpeningPortal ? "Opening..." : "Manage Subscription"}
                    </Text>
                  </Pressable>
                )}
              </>
            )}
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

        {/* Logs */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: c.textMuted }]}>Diagnostics</Text>
          <Pressable
            style={({ pressed }) => [
              styles.actionRow,
              { backgroundColor: c.bgCard, borderColor: c.border },
              pressed && styles.actionRowPressed,
            ]}
            onPress={() => setShowLogs(!showLogs)}
          >
            <Text style={[styles.actionRowLabel, { color: c.textPrimary }]}>
              Connection Logs ({logs.length})
            </Text>
            <Text style={[styles.actionRowChevron, { color: c.textMuted }]}>{showLogs ? "\u2303" : "\u2304"}</Text>
          </Pressable>
          <View style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.border, marginTop: 8 }]}>
            <View style={styles.themeRow}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.themeLabel, { color: c.textPrimary }]}>Force Relay</Text>
                <Text style={[{ fontSize: 12, color: c.textMuted, marginTop: 2 }]}>
                  Skip direct connection, always use relay server
                </Text>
              </View>
              <Switch
                value={forceRelay}
                onValueChange={(v) => {
                  setForceRelay(v);
                  quicClient.setForceRelay(v);
                  if (token) saveUserSettings(token, { forceRelay: v });
                  if (activeDevice) {
                    disconnect();
                    Alert.alert("Relay Mode Changed", "Disconnect and reconnect to apply.");
                  }
                }}
                trackColor={{ false: c.border, true: c.accent }}
                thumbColor="#ffffff"
              />
            </View>
          </View>

          {showLogs && (
            <View style={[styles.logsContainer, { backgroundColor: c.bgCard, borderColor: c.border }]}>
              <View style={styles.logsActions}>
                <Pressable onPress={() => {
                  const text = logs.map(l =>
                    `${new Date(l.timestamp).toLocaleTimeString()} [${l.level}] ${l.message}`
                  ).join("\n");
                  ExpoClipboard.setStringAsync(text);
                  Alert.alert("Copied", "Logs copied to clipboard.");
                }}>
                  <Text style={[styles.logsActionBtn, { color: c.accent }]}>Copy All</Text>
                </Pressable>
                <Pressable onPress={() => { clearLogEntries(); }}>
                  <Text style={[styles.logsActionBtn, { color: c.error }]}>Clear</Text>
                </Pressable>
              </View>
              <ScrollView style={styles.logsScroll} nestedScrollEnabled>
                {logs.length === 0 ? (
                  <Text style={[styles.logEmpty, { color: c.textMuted }]}>No logs yet.</Text>
                ) : (
                  logs.slice().reverse().map((entry, i) => (
                    <Text key={i} style={[styles.logLine, {
                      color: entry.level === "error" ? c.error : entry.level === "warn" ? "#eab308" : c.textSecondary,
                    }]}>
                      {new Date(entry.timestamp).toLocaleTimeString()} {entry.message}
                    </Text>
                  ))
                )}
              </ScrollView>
            </View>
          )}
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
              { label: "Website", onPress: () => Linking.openURL("https://yaver.io").catch(() => {}) },
              { label: "Privacy Policy", onPress: () => router.push("/legal/privacy") },
              { label: "Terms of Service", onPress: () => router.push("/legal/terms") },
              { label: "Contact", onPress: () => Linking.openURL("mailto:support@yaver.io").catch(() => {}) },
            ].map((link, i) => (
              <React.Fragment key={link.label}>
                {i > 0 && <View style={[styles.separator, { backgroundColor: c.borderSubtle }]} />}
                <Pressable
                  style={({ pressed }) => [
                    styles.linkRow,
                    pressed && { backgroundColor: c.bgCardElevated },
                  ]}
                  onPress={link.onPress}
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
          <Text style={[styles.sectionLabel, { color: c.error }]}>Danger Zone</Text>
          <View style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.error + "30" }]}>
            <Text style={[styles.dangerDescription, { color: c.textMuted }]}>
              Permanently delete your account and all associated data. This action cannot be undone.
            </Text>
            <Text style={[styles.dangerHint, { color: c.textMuted }]}>
              Type <Text style={{ color: c.textSecondary, fontFamily: "monospace" }}>delete my account</Text> to confirm:
            </Text>
            <TextInput
              style={[styles.deleteInput, { backgroundColor: c.bgCardElevated, borderColor: deleteConfirm === "delete my account" ? c.error : c.border, color: c.textPrimary }]}
              value={deleteConfirm}
              onChangeText={setDeleteConfirm}
              placeholder="delete my account"
              placeholderTextColor={c.textMuted}
              autoCapitalize="none"
              editable={!deletingAccount}
            />
            <Pressable
              style={({ pressed }) => [
                styles.deleteAccountButton,
                { borderColor: c.error + "30" },
                deleteConfirm === "delete my account"
                  ? { backgroundColor: c.error + "15" }
                  : { opacity: 0.3 },
                pressed && deleteConfirm === "delete my account" && { opacity: 0.7 },
              ]}
              onPress={handleDeleteAccount}
              disabled={deleteConfirm !== "delete my account" || deletingAccount}
            >
              <Text style={[styles.deleteAccountText, { color: c.error }]}>
                {deletingAccount ? "Deleting..." : "Delete My Account"}
              </Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
      </KeyboardAvoidingView>
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
  editNameRow: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1 },
  editNameInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    fontSize: 15,
  },
  editNameButton: {
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  editNameButtonText: { color: "#fff", fontSize: 13, fontWeight: "600" },

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
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  subscriptionLoading: {
    paddingVertical: 12,
    alignItems: "center",
  },
  manageButton: {
    marginTop: 14,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
  },
  manageButtonText: { fontSize: 14, fontWeight: "600" },

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

  dangerDescription: { fontSize: 13, lineHeight: 19, marginBottom: 12 },
  dangerHint: { fontSize: 12, marginBottom: 8 },
  deleteInput: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
    fontSize: 14,
    marginBottom: 12,
  },
  // Logs
  logsContainer: {
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 8,
    overflow: "hidden",
  },
  logsActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 16,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
  },
  logsActionBtn: { fontSize: 13, fontWeight: "600" },
  logsScroll: { maxHeight: 300, paddingHorizontal: 12, paddingBottom: 12 },
  logLine: { fontSize: 11, fontFamily: "monospace", lineHeight: 16, marginBottom: 1 },
  logEmpty: { fontSize: 13, textAlign: "center", paddingVertical: 20 },

  deleteAccountButton: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    alignItems: "center",
  },
  deleteAccountText: { fontSize: 14, fontWeight: "600" },
});
