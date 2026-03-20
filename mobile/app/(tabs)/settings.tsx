import Constants from "expo-constants";
import { router } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
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
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAuth } from "../../src/context/AuthContext";
import { useDevice } from "../../src/context/DeviceContext";
import { CUSTOM_RELAYS_KEY, CUSTOM_TUNNELS_KEY } from "../../src/context/DeviceContext";
import { useColors, useTheme } from "../../src/context/ThemeContext";
import { deleteAccount as deleteAccountApi, updateProfile, getUserSettings, saveUserSettings, getAiRunners, type AiRunner, getDeviceMetrics, getDeviceEvents, type DeviceMetric, type DeviceEvent, getUsageSummary, type UsageSummary } from "../../src/lib/auth";
import { clearCache } from "../../src/lib/storage";
import * as ExpoClipboard from "expo-clipboard";
import { getLogEntries, clearLogEntries, onLogsChanged, LogEntry } from "../../src/lib/logger";
import { quicClient, type AgentStatus, type RelayServer, type TunnelServer } from "../../src/lib/quic";

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
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>(getLogEntries());
  const [forceRelay, setForceRelay] = useState(quicClient.forceRelay);
  const [debugLogsEnabled, setDebugLogsEnabled] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [guideSection, setGuideSection] = useState<string | null>(null);
  const [runners, setRunners] = useState<AiRunner[]>([]);
  const [selectedRunner, setSelectedRunner] = useState<string>("claude");
  const [customRunnerCommand, setCustomRunnerCommand] = useState("");
  const [agentVersion, setAgentVersion] = useState<string | null>(null);
  const [agentLastPing, setAgentLastPing] = useState<Date | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [pingRtt, setPingRtt] = useState<number | null>(null);
  const [isPinging, setIsPinging] = useState(false);
  const [isShuttingDown, setIsShuttingDown] = useState(false);
  const [metrics, setMetrics] = useState<DeviceMetric[]>([]);
  const [events, setEvents] = useState<DeviceEvent[]>([]);
  const [showMetrics, setShowMetrics] = useState(false);
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);

  const scrollViewRef = useRef<ScrollView>(null);

  // Relay servers
  const [customRelays, setCustomRelays] = useState<RelayServer[]>([]);
  const [showAddRelay, setShowAddRelay] = useState(false);
  const [newRelayUrl, setNewRelayUrl] = useState("");
  const [newRelayPassword, setNewRelayPassword] = useState("");
  const [newRelayLabel, setNewRelayLabel] = useState("");
  const [testingRelayId, setTestingRelayId] = useState<string | null>(null);
  const [relayTestResults, setRelayTestResults] = useState<Record<string, { ok: boolean; ms?: number; error?: string }>>({});
  const [relaySyncEnabled, setRelaySyncEnabled] = useState(false);

  // Cloudflare Tunnels
  const [customTunnels, setCustomTunnels] = useState<TunnelServer[]>([]);
  const [showAddTunnel, setShowAddTunnel] = useState(false);
  const [newTunnelUrl, setNewTunnelUrl] = useState("");
  const [newTunnelCfClientId, setNewTunnelCfClientId] = useState("");
  const [newTunnelCfClientSecret, setNewTunnelCfClientSecret] = useState("");
  const [newTunnelLabel, setNewTunnelLabel] = useState("");
  const [testingTunnelId, setTestingTunnelId] = useState<string | null>(null);
  const [tunnelTestResults, setTunnelTestResults] = useState<Record<string, { ok: boolean; ms?: number; error?: string }>>({});

  // Scroll down when add-relay / add-tunnel / keyboard opens so inputs stay visible
  useEffect(() => {
    if (showAddRelay || showAddTunnel) {
      setTimeout(() => scrollViewRef.current?.scrollToEnd({ animated: true }), 300);
    }
  }, [showAddRelay, showAddTunnel]);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const sub = Keyboard.addListener("keyboardDidShow", () => {
      setTimeout(() => scrollViewRef.current?.scrollToEnd({ animated: true }), 100);
    });
    return () => sub.remove();
  }, []);

  // Load custom relay servers and sync preference from AsyncStorage
  useEffect(() => {
    AsyncStorage.getItem(CUSTOM_RELAYS_KEY).then((raw) => {
      if (raw) {
        try {
          setCustomRelays(JSON.parse(raw));
        } catch {}
      }
    });
    AsyncStorage.getItem("@yaver/relay_sync_enabled").then((val) => {
      setRelaySyncEnabled(val === "true");
    });
    AsyncStorage.getItem("@yaver/debug_logs_enabled").then((val) => {
      setDebugLogsEnabled(val === "true");
    });
    AsyncStorage.getItem(CUSTOM_TUNNELS_KEY).then((raw) => {
      if (raw) {
        try {
          const tunnels = JSON.parse(raw);
          setCustomTunnels(tunnels);
          if (tunnels.length > 0) {
            quicClient.setTunnelServers(tunnels);
          }
        } catch {}
      }
    });
  }, []);

  const saveCustomRelays = async (relays: RelayServer[]) => {
    setCustomRelays(relays);
    await AsyncStorage.setItem(CUSTOM_RELAYS_KEY, JSON.stringify(relays));
    if (relays.length > 0) {
      quicClient.setRelayServers(relays);
    }
    // Sync primary relay to Convex user settings only if cloud sync is enabled
    const syncEnabled = await AsyncStorage.getItem("@yaver/relay_sync_enabled");
    if (token && syncEnabled === "true") {
      const primary = relays.length > 0 ? relays[0] : null;
      saveUserSettings(token, {
        relayUrl: primary?.httpUrl ?? "",
      });
    }
  };

  const handleToggleRelaySync = async (enabled: boolean) => {
    setRelaySyncEnabled(enabled);
    await AsyncStorage.setItem("@yaver/relay_sync_enabled", enabled ? "true" : "false");
    if (enabled && token) {
      const primary = customRelays.length > 0 ? customRelays[0] : null;
      const primaryTunnel = customTunnels.length > 0 ? customTunnels[0] : null;
      saveUserSettings(token, {
        relayUrl: primary?.httpUrl ?? "",
        tunnelUrl: primaryTunnel?.url ?? "",
      });
    } else if (!enabled && token) {
      saveUserSettings(token, { relayUrl: "", tunnelUrl: "" });
    }
  };

  const handleAddRelay = async () => {
    const url = newRelayUrl.trim().replace(/\/+$/, "");
    if (!url) {
      Alert.alert("Error", "URL is required.");
      return;
    }

    // Generate ID from URL hash
    let h = 0;
    for (let i = 0; i < url.length; i++) {
      h = ((h * 31) + url.charCodeAt(i)) >>> 0;
    }
    const id = h.toString(16).slice(0, 8);

    // Check duplicate
    if (customRelays.some((r) => r.httpUrl === url)) {
      Alert.alert("Error", "This relay server is already configured.");
      return;
    }

    // Infer QUIC address
    let host = url.replace(/^https?:\/\//, "").replace(/:\d+$/, "").replace(/\/.*$/, "");
    const quicAddr = host + ":4433";

    const relay: RelayServer = {
      id,
      quicAddr,
      httpUrl: url,
      region: newRelayLabel.trim() || "custom",
      priority: customRelays.length + 1,
      password: newRelayPassword.trim() || undefined,
    };

    await saveCustomRelays([...customRelays, relay]);
    setNewRelayUrl("");
    setNewRelayPassword("");
    setNewRelayLabel("");
    setShowAddRelay(false);
  };

  const handleRemoveRelay = (relayId: string) => {
    Alert.alert("Remove Relay", "Remove this relay server?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => saveCustomRelays(customRelays.filter((r) => r.id !== relayId)),
      },
    ]);
  };

  const handleTestRelay = async (relay: RelayServer) => {
    setTestingRelayId(relay.id);
    try {
      const start = Date.now();
      const res = await fetch(relay.httpUrl + "/health", { method: "GET" });
      const ms = Date.now() - start;
      if (res.ok) {
        setRelayTestResults((prev) => ({ ...prev, [relay.id]: { ok: true, ms } }));
      } else {
        setRelayTestResults((prev) => ({ ...prev, [relay.id]: { ok: false, error: `HTTP ${res.status}` } }));
      }
    } catch (e) {
      setRelayTestResults((prev) => ({ ...prev, [relay.id]: { ok: false, error: String(e) } }));
    } finally {
      setTestingRelayId(null);
    }
  };

  const saveCustomTunnels = async (tunnels: TunnelServer[]) => {
    setCustomTunnels(tunnels);
    await AsyncStorage.setItem(CUSTOM_TUNNELS_KEY, JSON.stringify(tunnels));
    if (tunnels.length > 0) {
      quicClient.setTunnelServers(tunnels);
    }
  };

  const handleAddTunnel = async () => {
    const url = newTunnelUrl.trim().replace(/\/+$/, "");
    if (!url) {
      Alert.alert("Error", "URL is required.");
      return;
    }
    let h = 0;
    for (let i = 0; i < url.length; i++) {
      h = ((h * 31) + url.charCodeAt(i)) >>> 0;
    }
    const id = h.toString(16).slice(0, 8);
    if (customTunnels.some((t) => t.url === url)) {
      Alert.alert("Error", "This tunnel is already configured.");
      return;
    }
    const tunnel: TunnelServer = {
      id,
      url,
      cfAccessClientId: newTunnelCfClientId.trim() || undefined,
      cfAccessClientSecret: newTunnelCfClientSecret.trim() || undefined,
      label: newTunnelLabel.trim() || undefined,
      priority: customTunnels.length + 1,
    };
    await saveCustomTunnels([...customTunnels, tunnel]);
    setNewTunnelUrl("");
    setNewTunnelCfClientId("");
    setNewTunnelCfClientSecret("");
    setNewTunnelLabel("");
    setShowAddTunnel(false);
  };

  const handleRemoveTunnel = (tunnelId: string) => {
    Alert.alert("Remove Tunnel", "Remove this Cloudflare Tunnel?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => saveCustomTunnels(customTunnels.filter((t) => t.id !== tunnelId)),
      },
    ]);
  };

  const handleTestTunnel = async (tunnel: TunnelServer) => {
    setTestingTunnelId(tunnel.id);
    try {
      const start = Date.now();
      const headers: Record<string, string> = {};
      if (tunnel.cfAccessClientId) {
        headers['CF-Access-Client-Id'] = tunnel.cfAccessClientId;
        headers['CF-Access-Client-Secret'] = tunnel.cfAccessClientSecret || '';
      }
      const res = await fetch(tunnel.url + "/health", { method: "GET", headers });
      const ms = Date.now() - start;
      if (res.ok) {
        setTunnelTestResults((prev) => ({ ...prev, [tunnel.id]: { ok: true, ms } }));
      } else {
        setTunnelTestResults((prev) => ({ ...prev, [tunnel.id]: { ok: false, error: `HTTP ${res.status}` } }));
      }
    } catch (e) {
      setTunnelTestResults((prev) => ({ ...prev, [tunnel.id]: { ok: false, error: String(e) } }));
    } finally {
      setTestingTunnelId(null);
    }
  };

  // Load user settings, runners, and usage from Convex
  useEffect(() => {
    if (!token) return;
    getUserSettings(token).then((s) => {
      if (s.forceRelay !== undefined) {
        setForceRelay(s.forceRelay);
        quicClient.setForceRelay(s.forceRelay);
      }
      if (s.runnerId) setSelectedRunner(s.runnerId);
      if (s.customRunnerCommand) setCustomRunnerCommand(s.customRunnerCommand);
    });
    getAiRunners().then(setRunners);
    getUsageSummary(token).then(setUsageSummary);
  }, [token]);

  // Subscribe to live log updates
  useEffect(() => {
    return onLogsChanged(() => setLogs(getLogEntries()));
  }, []);

  // Ping the agent for version when connected
  useEffect(() => {
    if (connectionStatus !== "connected" || !activeDevice) {
      setAgentVersion(null);
      setAgentLastPing(null);
      setAgentStatus(null);
      return;
    }
    (async () => {
      try {
        const [info, status] = await Promise.all([
          quicClient.getInfo(),
          quicClient.getAgentStatus(),
        ]);
        if (info) {
          setAgentVersion(info.version || null);
          setAgentLastPing(new Date());
        }
        if (status) setAgentStatus(status);
      } catch {
        // Agent unreachable — leave as null
      }
    })();
  }, [connectionStatus, activeDevice]);

  // Ping agent every 10s when connected
  useEffect(() => {
    if (connectionStatus !== "connected") {
      setPingRtt(null);
      return;
    }
    const doPing = async () => {
      const result = await quicClient.ping();
      if (result.ok) setPingRtt(result.rttMs);
    };
    doPing();
    const interval = setInterval(doPing, 10000);
    return () => clearInterval(interval);
  }, [connectionStatus]);

  const handlePing = async () => {
    setIsPinging(true);
    const result = await quicClient.ping();
    setPingRtt(result.ok ? result.rttMs : null);
    setIsPinging(false);
  };

  const handleShutdownAgent = () => {
    Alert.alert(
      "Shutdown Agent",
      "This will stop the Yaver agent on your desktop. You won't be able to send tasks until it's restarted.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Shutdown",
          style: "destructive",
          onPress: async () => {
            setIsShuttingDown(true);
            const ok = await quicClient.shutdownAgent();
            setIsShuttingDown(false);
            if (ok) {
              disconnect();
              Alert.alert("Done", "Agent has been shut down.");
            } else {
              Alert.alert("Error", "Failed to shutdown agent.");
            }
          },
        },
      ]
    );
  };

  // Fetch device metrics every 60s when connected
  useEffect(() => {
    if (!token || !activeDevice || connectionStatus !== "connected") {
      setMetrics([]);
      setEvents([]);
      return;
    }
    const fetchMetrics = async () => {
      const [m, e] = await Promise.all([
        getDeviceMetrics(token, activeDevice.id),
        getDeviceEvents(token, activeDevice.id),
      ]);
      setMetrics(m);
      setEvents(e);
    };
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 60000);
    return () => clearInterval(interval);
  }, [token, activeDevice, connectionStatus]);


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
        keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
      >
      <ScrollView
        ref={scrollViewRef}
        style={styles.container}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
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
                  <Text style={[styles.detailLabel, { color: c.textMuted }]}>Mode</Text>
                  <Text style={[styles.detailValue, { color: c.textPrimary }]}>
                    {quicClient.connectionMode || "—"}
                  </Text>
                </View>
                {agentVersion && (
                  <View style={styles.detailItem}>
                    <Text style={[styles.detailLabel, { color: c.textMuted }]}>Agent</Text>
                    <Text style={[styles.detailValue, { color: c.textPrimary }]}>v{agentVersion}</Text>
                  </View>
                )}
                <View style={styles.detailItem}>
                  <Text style={[styles.detailLabel, { color: c.textMuted }]}>Last seen</Text>
                  <Text style={[styles.detailValue, { color: c.textPrimary }]}>
                    {agentLastPing
                      ? agentLastPing.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
                      : activeDevice.lastSeen
                        ? new Date(activeDevice.lastSeen).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                        : "Unknown"}
                  </Text>
                </View>
              </View>
              {/* Ping + Shutdown row */}
              <View style={[styles.deviceDetails, { borderTopColor: c.borderSubtle }]}>
                <Pressable
                  style={({ pressed }) => [
                    { flexDirection: "row", alignItems: "center", paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6, backgroundColor: c.bgCardElevated },
                    pressed && { opacity: 0.7 },
                  ]}
                  onPress={handlePing}
                  disabled={isPinging}
                >
                  <Text style={{ fontSize: 13, color: c.accent }}>
                    {isPinging ? "Pinging..." : pingRtt !== null ? `${pingRtt}ms` : "Ping"}
                  </Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [
                    { paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6, backgroundColor: c.errorBg },
                    pressed && { opacity: 0.7 },
                  ]}
                  onPress={handleShutdownAgent}
                  disabled={isShuttingDown}
                >
                  <Text style={{ fontSize: 13, color: c.error }}>
                    {isShuttingDown ? "Stopping..." : "Shutdown"}
                  </Text>
                </Pressable>
              </View>
              {/* Runner status */}
              {agentStatus && (
                <View style={[styles.deviceDetails, { borderTopColor: c.borderSubtle }]}>
                  <View style={styles.detailItem}>
                    <Text style={[styles.detailLabel, { color: c.textMuted }]}>Runner</Text>
                    <Text style={[styles.detailValue, { color: c.textPrimary }]}>
                      {agentStatus.runner.name}
                    </Text>
                  </View>
                  <View style={styles.detailItem}>
                    <Text style={[styles.detailLabel, { color: c.textMuted }]}>Status</Text>
                    <Text style={[styles.detailValue, {
                      color: agentStatus.runner.installed ? c.success : c.error,
                    }]}>
                      {agentStatus.runner.installed ? "Ready" : "Not found"}
                    </Text>
                  </View>
                  <View style={styles.detailItem}>
                    <Text style={[styles.detailLabel, { color: c.textMuted }]}>Tasks</Text>
                    <Text style={[styles.detailValue, { color: c.textPrimary }]}>
                      {agentStatus.runningTasks}/{agentStatus.totalTasks}
                    </Text>
                  </View>
                </View>
              )}
            </View>
          ) : (
            <View style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.border }]}>
              <Text style={[styles.noDeviceText, { color: c.textMuted }]}>
                No device connected. Go to the Devices tab to connect.
              </Text>
            </View>
          )}
        </View>

        {/* Device Metrics */}
        {activeDevice && connectionStatus === "connected" && (
          <View style={styles.section}>
            <Pressable onPress={() => setShowMetrics(!showMetrics)}>
              <Text style={[styles.sectionLabel, { color: c.textMuted }]}>
                Device Metrics {showMetrics ? "\u2303" : "\u2304"}
              </Text>
            </Pressable>
            {showMetrics && (
              <View style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.border }]}>
                {metrics.length === 0 ? (
                  <Text style={[{ fontSize: 13, color: c.textMuted, textAlign: "center", paddingVertical: 12 }]}>
                    Waiting for metrics... (updates every 60s)
                  </Text>
                ) : (
                  <>
                    {/* CPU Chart */}
                    <Text style={[styles.detailLabel, { color: c.textMuted, marginBottom: 6 }]}>
                      CPU — {metrics.length > 0 ? `${metrics[metrics.length - 1].cpuPercent.toFixed(1)}%` : "—"}
                    </Text>
                    <View style={metricsStyles.chartContainer}>
                      {metrics.slice(-60).map((m, i) => (
                        <View
                          key={i}
                          style={[
                            metricsStyles.bar,
                            {
                              height: `${Math.max(m.cpuPercent, 2)}%` as any,
                              backgroundColor: m.cpuPercent > 80 ? c.error : m.cpuPercent > 50 ? c.warn : c.accent,
                            },
                          ]}
                        />
                      ))}
                    </View>

                    {/* RAM Chart */}
                    <Text style={[styles.detailLabel, { color: c.textMuted, marginBottom: 6, marginTop: 16 }]}>
                      RAM — {metrics.length > 0
                        ? `${(metrics[metrics.length - 1].memoryUsedMb / 1024).toFixed(1)} / ${(metrics[metrics.length - 1].memoryTotalMb / 1024).toFixed(1)} GB`
                        : "—"}
                    </Text>
                    <View style={metricsStyles.chartContainer}>
                      {metrics.slice(-60).map((m, i) => {
                        const pct = m.memoryTotalMb > 0 ? (m.memoryUsedMb / m.memoryTotalMb) * 100 : 0;
                        return (
                          <View
                            key={i}
                            style={[
                              metricsStyles.bar,
                              {
                                height: `${Math.max(pct, 2)}%` as any,
                                backgroundColor: pct > 85 ? c.error : pct > 60 ? c.warn : c.success,
                              },
                            ]}
                          />
                        );
                      })}
                    </View>

                    {/* Time range label */}
                    <View style={metricsStyles.timeLabels}>
                      <Text style={[{ fontSize: 10, color: c.textMuted }]}>-60 min</Text>
                      <Text style={[{ fontSize: 10, color: c.textMuted }]}>now</Text>
                    </View>
                  </>
                )}

                {/* Recent events */}
                {events.length > 0 && (
                  <View style={{ marginTop: 16, borderTopWidth: 1, borderTopColor: c.borderSubtle, paddingTop: 12 }}>
                    <Text style={[styles.detailLabel, { color: c.textMuted, marginBottom: 8 }]}>
                      Recent Events
                    </Text>
                    {events.slice(0, 5).map((e, i) => (
                      <View key={i} style={{ flexDirection: "row", alignItems: "center", marginBottom: 4 }}>
                        <Text style={{ fontSize: 11, color: e.event === "crash" || e.event === "oom" ? c.error : e.event === "restart" ? c.warn : c.success }}>
                          {e.event === "crash" ? "\u26A0" : e.event === "started" ? "\u25B6" : e.event === "restart" ? "\u21BB" : e.event === "stopped" ? "\u25A0" : "\u26A0"}
                        </Text>
                        <Text style={{ fontSize: 11, color: c.textSecondary, marginLeft: 6, flex: 1 }}>
                          {e.event} {e.details ? `— ${e.details}` : ""}
                        </Text>
                        <Text style={{ fontSize: 10, color: c.textMuted }}>
                          {new Date(e.timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            )}
          </View>
        )}

        {/* Yaver Usage */}
        {usageSummary && usageSummary.daily.length > 0 && (
          <View style={styles.section}>
            <Text style={[styles.sectionLabel, { color: c.textMuted }]}>Yaver Usage (30 days)</Text>
            <View style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.border }]}>
              <View style={styles.aboutRow}>
                <Text style={[styles.aboutLabel, { color: c.textPrimary }]}>Total Tasks</Text>
                <Text style={[styles.aboutValue, { color: c.accent, fontWeight: "600" }]}>
                  {usageSummary.daily.reduce((sum, d) => sum + d.taskCount, 0)}
                </Text>
              </View>
              <View style={[styles.separator, { backgroundColor: c.borderSubtle }]} />
              <View style={styles.aboutRow}>
                <Text style={[styles.aboutLabel, { color: c.textPrimary }]}>Total Time</Text>
                <Text style={[styles.aboutValue, { color: c.accent, fontWeight: "600" }]}>
                  {usageSummary.totalSeconds >= 3600
                    ? `${(usageSummary.totalSeconds / 3600).toFixed(1)}h`
                    : `${Math.round(usageSummary.totalSeconds / 60)}m`}
                </Text>
              </View>
              {(() => {
                const runners: Record<string, number> = {};
                for (const d of usageSummary.daily) {
                  for (const [r, secs] of Object.entries(d.runners)) {
                    runners[r] = (runners[r] || 0) + secs;
                  }
                }
                const sorted = Object.entries(runners).sort((a, b) => b[1] - a[1]);
                if (sorted.length === 0) return null;
                return sorted.map(([runner, secs]) => (
                  <React.Fragment key={runner}>
                    <View style={[styles.separator, { backgroundColor: c.borderSubtle }]} />
                    <View style={styles.aboutRow}>
                      <Text style={[styles.aboutLabel, { color: c.textPrimary }]}>{runner}</Text>
                      <Text style={[styles.aboutValue, { color: c.textMuted }]}>
                        {secs >= 3600
                          ? `${(secs / 3600).toFixed(1)}h`
                          : `${Math.round(secs / 60)}m`}
                      </Text>
                    </View>
                  </React.Fragment>
                ));
              })()}
            </View>
          </View>
        )}

        {/* AI Runner */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: c.textMuted }]}>AI Runner</Text>
          <View style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.border }]}>
            {runners.map((runner) => {
              const selected = selectedRunner === runner.runnerId;
              return (
                <Pressable
                  key={runner.runnerId}
                  style={[styles.runnerOption, { borderBottomColor: c.borderSubtle }]}
                  onPress={() => {
                    setSelectedRunner(runner.runnerId);
                    if (token) saveUserSettings(token, { runnerId: runner.runnerId });
                  }}
                >
                  <View style={[styles.radioOuter, { borderColor: selected ? c.accent : c.border }]}>
                    {selected && <View style={[styles.radioInner, { backgroundColor: c.accent }]} />}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.runnerName, { color: c.textPrimary }]}>{runner.name}</Text>
                    <Text style={[styles.runnerDesc, { color: c.textMuted }]}>{runner.description}</Text>
                  </View>
                </Pressable>
              );
            })}
            <Pressable
              style={styles.runnerOption}
              onPress={() => {
                setSelectedRunner("custom");
                if (token) saveUserSettings(token, { runnerId: "custom", customRunnerCommand });
              }}
            >
              <View style={[styles.radioOuter, { borderColor: selectedRunner === "custom" ? c.accent : c.border }]}>
                {selectedRunner === "custom" && <View style={[styles.radioInner, { backgroundColor: c.accent }]} />}
              </View>
              <Text style={[styles.runnerName, { color: c.textPrimary }]}>Custom</Text>
            </Pressable>
            {selectedRunner === "custom" && (
              <TextInput
                style={[styles.customRunnerInput, { backgroundColor: c.bgCardElevated, borderColor: c.border, color: c.textPrimary }]}
                placeholder='my-tool --auto "{prompt}"'
                placeholderTextColor={c.textMuted}
                value={customRunnerCommand}
                onChangeText={(text) => {
                  setCustomRunnerCommand(text);
                  if (token) saveUserSettings(token, { runnerId: "custom", customRunnerCommand: text });
                }}
                autoCapitalize="none"
                autoCorrect={false}
              />
            )}
          </View>
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
                }}
                trackColor={{ false: c.border, true: c.accent }}
                thumbColor="#ffffff"
              />
            </View>
          </View>

          <View style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.border, marginTop: 8 }]}>
            <View style={styles.themeRow}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.themeLabel, { color: c.textPrimary }]}>Debug Logs</Text>
                <Text style={[{ fontSize: 12, color: c.textMuted, marginTop: 2 }]}>
                  Send connection diagnostics to Yaver servers for troubleshooting
                </Text>
              </View>
              <Switch
                value={debugLogsEnabled}
                onValueChange={(v) => {
                  setDebugLogsEnabled(v);
                  AsyncStorage.setItem("@yaver/debug_logs_enabled", v ? "true" : "false");
                }}
                trackColor={{ false: c.border, true: c.accent }}
                thumbColor="#ffffff"
              />
            </View>
          </View>

          {/* Relay Servers */}
          <View style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.border, marginTop: 8 }]}>
            <View style={styles.themeRow}>
              <Text style={[styles.themeLabel, { color: c.textPrimary }]}>Relay Servers</Text>
              <Pressable
                style={({ pressed }) => [
                  { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 6, backgroundColor: c.accent },
                  pressed && { opacity: 0.7 },
                ]}
                onPress={() => setShowAddRelay(!showAddRelay)}
              >
                <Text style={{ fontSize: 13, color: "#fff", fontWeight: "600" }}>
                  {showAddRelay ? "Cancel" : "+ Add"}
                </Text>
              </Pressable>
            </View>

            {showAddRelay && (
              <View style={{ marginTop: 12, gap: 8 }}>
                <TextInput
                  style={[styles.relayInput, { backgroundColor: c.bgCardElevated, borderColor: c.border, color: c.textPrimary }]}
                  placeholder="https://relay.example.com"
                  placeholderTextColor={c.textMuted}
                  value={newRelayUrl}
                  onChangeText={setNewRelayUrl}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
                <TextInput
                  style={[styles.relayInput, { backgroundColor: c.bgCardElevated, borderColor: c.border, color: c.textPrimary }]}
                  placeholder="Password (optional)"
                  placeholderTextColor={c.textMuted}
                  value={newRelayPassword}
                  onChangeText={setNewRelayPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                />
                <TextInput
                  style={[styles.relayInput, { backgroundColor: c.bgCardElevated, borderColor: c.border, color: c.textPrimary }]}
                  placeholder="Label (optional) e.g. My VPS"
                  placeholderTextColor={c.textMuted}
                  value={newRelayLabel}
                  onChangeText={setNewRelayLabel}
                  autoCapitalize="none"
                />
                <Pressable
                  style={({ pressed }) => [
                    { paddingVertical: 10, borderRadius: 8, backgroundColor: c.accent, alignItems: "center" as const },
                    pressed && { opacity: 0.7 },
                  ]}
                  onPress={handleAddRelay}
                >
                  <Text style={{ color: "#fff", fontWeight: "600", fontSize: 14 }}>Add Relay Server</Text>
                </Pressable>
              </View>
            )}

            {customRelays.length === 0 && !showAddRelay && (
              <View style={{ marginTop: 8 }}>
                <Text style={{ fontSize: 12, color: c.textMuted }}>
                  Using default relay servers. Add your own to use a self-hosted relay.
                </Text>
                <Text
                  style={{ fontSize: 12, color: c.accent, marginTop: 4 }}
                  onPress={() => Linking.openURL("https://yaver.io/docs/self-hosting")}
                >
                  Learn more about self-hosting a relay
                </Text>
              </View>
            )}

            {customRelays.map((relay) => {
              const testResult = relayTestResults[relay.id];
              return (
                <View
                  key={relay.id}
                  style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: c.borderSubtle }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, color: c.textPrimary, fontWeight: "500" }}>
                        {relay.region !== "custom" ? relay.region : relay.httpUrl}
                      </Text>
                      {relay.region !== "custom" && (
                        <Text style={{ fontSize: 11, color: c.textMuted, marginTop: 2 }}>{relay.httpUrl}</Text>
                      )}
                    </View>
                    {testResult && (
                      <View style={{
                        width: 8, height: 8, borderRadius: 4, marginRight: 8,
                        backgroundColor: testResult.ok ? c.success : c.error,
                      }} />
                    )}
                  </View>
                  <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                    <Pressable
                      style={({ pressed }) => [
                        { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 6, backgroundColor: c.bgCardElevated },
                        pressed && { opacity: 0.7 },
                      ]}
                      onPress={() => handleTestRelay(relay)}
                      disabled={testingRelayId === relay.id}
                    >
                      {testingRelayId === relay.id ? (
                        <ActivityIndicator size="small" color={c.accent} />
                      ) : (
                        <Text style={{ fontSize: 12, color: c.accent }}>
                          {testResult ? (testResult.ok ? `OK ${testResult.ms}ms` : "Failed") : "Test"}
                        </Text>
                      )}
                    </Pressable>
                    <Pressable
                      style={({ pressed }) => [
                        { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 6, backgroundColor: c.errorBg },
                        pressed && { opacity: 0.7 },
                      ]}
                      onPress={() => handleRemoveRelay(relay.id)}
                    >
                      <Text style={{ fontSize: 12, color: c.error }}>Remove</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}

            {/* Sync to cloud toggle */}
            <View style={{ marginTop: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: c.borderSubtle }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <View style={{ flex: 1, marginRight: 12 }}>
                  <Text style={{ fontSize: 14, color: c.textPrimary, fontWeight: "500" }}>Sync to cloud</Text>
                  <Text style={{ fontSize: 11, color: c.textMuted, marginTop: 2 }}>
                    Sync relay and tunnel URLs to your account (accessible from other devices). Passwords and secrets are always stored locally only.
                  </Text>
                </View>
                <Switch
                  value={relaySyncEnabled}
                  onValueChange={handleToggleRelaySync}
                  trackColor={{ false: c.border, true: c.accent }}
                />
              </View>
            </View>
          </View>

          {/* Cloudflare Tunnel */}
          <View style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.border, marginTop: 8 }]}>
            <View style={styles.themeRow}>
              <Text style={[styles.themeLabel, { color: c.textPrimary }]}>Cloudflare Tunnel</Text>
              <Pressable
                style={({ pressed }) => [
                  { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 6, backgroundColor: c.accent },
                  pressed && { opacity: 0.7 },
                ]}
                onPress={() => setShowAddTunnel(!showAddTunnel)}
              >
                <Text style={{ fontSize: 13, color: "#fff", fontWeight: "600" }}>
                  {showAddTunnel ? "Cancel" : "+ Add"}
                </Text>
              </Pressable>
            </View>

            {showAddTunnel && (
              <View style={{ marginTop: 12, gap: 8 }}>
                <TextInput
                  style={[styles.relayInput, { backgroundColor: c.bgCardElevated, borderColor: c.border, color: c.textPrimary }]}
                  placeholder="https://tunnel.yourdomain.com"
                  placeholderTextColor={c.textMuted}
                  value={newTunnelUrl}
                  onChangeText={setNewTunnelUrl}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
                <TextInput
                  style={[styles.relayInput, { backgroundColor: c.bgCardElevated, borderColor: c.border, color: c.textPrimary }]}
                  placeholder="CF Access Client ID (optional)"
                  placeholderTextColor={c.textMuted}
                  value={newTunnelCfClientId}
                  onChangeText={setNewTunnelCfClientId}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TextInput
                  style={[styles.relayInput, { backgroundColor: c.bgCardElevated, borderColor: c.border, color: c.textPrimary }]}
                  placeholder="CF Access Client Secret (optional)"
                  placeholderTextColor={c.textMuted}
                  value={newTunnelCfClientSecret}
                  onChangeText={setNewTunnelCfClientSecret}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                />
                <TextInput
                  style={[styles.relayInput, { backgroundColor: c.bgCardElevated, borderColor: c.border, color: c.textPrimary }]}
                  placeholder="Label (optional) e.g. My Tunnel"
                  placeholderTextColor={c.textMuted}
                  value={newTunnelLabel}
                  onChangeText={setNewTunnelLabel}
                  autoCapitalize="none"
                />
                <Pressable
                  style={({ pressed }) => [
                    { paddingVertical: 10, borderRadius: 8, backgroundColor: c.accent, alignItems: "center" as const },
                    pressed && { opacity: 0.7 },
                  ]}
                  onPress={handleAddTunnel}
                >
                  <Text style={{ color: "#fff", fontWeight: "600", fontSize: 14 }}>Add Tunnel</Text>
                </Pressable>
              </View>
            )}

            {customTunnels.length === 0 && !showAddTunnel && (
              <View style={{ marginTop: 8 }}>
                <Text style={{ fontSize: 12, color: c.textMuted }}>
                  No Cloudflare Tunnels configured. Use tunnels to connect through firewalls via HTTPS.
                </Text>
              </View>
            )}

            {customTunnels.map((tunnel) => {
              const testResult = tunnelTestResults[tunnel.id];
              return (
                <View
                  key={tunnel.id}
                  style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: c.borderSubtle }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, color: c.textPrimary, fontWeight: "500" }}>
                        {tunnel.label || tunnel.url}
                      </Text>
                      {tunnel.label && (
                        <Text style={{ fontSize: 11, color: c.textMuted, marginTop: 2 }}>{tunnel.url}</Text>
                      )}
                      {tunnel.cfAccessClientId && (
                        <Text style={{ fontSize: 10, color: c.accent, marginTop: 2 }}>CF Access enabled</Text>
                      )}
                    </View>
                    {testResult && (
                      <View style={{
                        width: 8, height: 8, borderRadius: 4, marginRight: 8,
                        backgroundColor: testResult.ok ? c.success : c.error,
                      }} />
                    )}
                  </View>
                  <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                    <Pressable
                      style={({ pressed }) => [
                        { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 6, backgroundColor: c.bgCardElevated },
                        pressed && { opacity: 0.7 },
                      ]}
                      onPress={() => handleTestTunnel(tunnel)}
                      disabled={testingTunnelId === tunnel.id}
                    >
                      {testingTunnelId === tunnel.id ? (
                        <ActivityIndicator size="small" color={c.accent} />
                      ) : (
                        <Text style={{ fontSize: 12, color: c.accent }}>
                          {testResult ? (testResult.ok ? `OK ${testResult.ms}ms` : "Failed") : "Test"}
                        </Text>
                      )}
                    </Pressable>
                    <Pressable
                      style={({ pressed }) => [
                        { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 6, backgroundColor: c.errorBg },
                        pressed && { opacity: 0.7 },
                      ]}
                      onPress={() => handleRemoveTunnel(tunnel.id)}
                    >
                      <Text style={{ fontSize: 12, color: c.error }}>Remove</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>

          {/* Setup Guide — collapsible */}
          <Pressable
            style={({ pressed }) => [
              styles.actionRow,
              { backgroundColor: c.bgCard, borderColor: c.border, marginTop: 8 },
              pressed && styles.actionRowPressed,
            ]}
            onPress={() => setShowGuide(!showGuide)}
          >
            <Text style={[styles.actionRowLabel, { color: c.textPrimary }]}>Setup Guide</Text>
            <Text style={[styles.actionRowChevron, { color: c.textMuted }]}>{showGuide ? "\u2303" : "\u2304"}</Text>
          </Pressable>

          {showGuide && (
            <View style={[styles.card, { backgroundColor: c.bgCard, borderColor: c.border, marginTop: 4 }]}>
              {/* How connections work */}
              <Pressable onPress={() => setGuideSection(guideSection === "connections" ? null : "connections")}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 10 }}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: c.textPrimary }}>How connections work</Text>
                  <Text style={{ color: c.textMuted }}>{guideSection === "connections" ? "\u2303" : "\u2304"}</Text>
                </View>
              </Pressable>
              {guideSection === "connections" && (
                <View style={{ paddingBottom: 12 }}>
                  <Text style={{ fontSize: 12, color: c.textMuted, lineHeight: 18 }}>
                    Yaver tries connections in this order:{"\n\n"}
                    1. LAN direct (same WiFi, ~5ms){"\n"}
                    2. Cloudflare Tunnel (any network, HTTPS){"\n"}
                    3. Relay server (any network, QUIC){"\n\n"}
                    On the same WiFi, your machine is discovered automatically via UDP beacon. No configuration needed.{"\n\n"}
                    For remote access (phone on cellular, machine at home), set up a Cloudflare Tunnel or a relay server.{"\n\n"}
                    Network transitions (WiFi to cellular and back) are seamless — the app reconnects automatically without interruption.
                  </Text>
                </View>
              )}

              <View style={{ height: 1, backgroundColor: c.borderSubtle }} />

              {/* Getting started */}
              <Pressable onPress={() => setGuideSection(guideSection === "getting-started" ? null : "getting-started")}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 10 }}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: c.textPrimary }}>Getting started</Text>
                  <Text style={{ color: c.textMuted }}>{guideSection === "getting-started" ? "\u2303" : "\u2304"}</Text>
                </View>
              </Pressable>
              {guideSection === "getting-started" && (
                <View style={{ paddingBottom: 12 }}>
                  <Text style={{ fontSize: 12, color: c.textMuted, lineHeight: 18 }}>
                    1. Install the CLI on your dev machine:{"\n\n"}
                  </Text>
                  <Text style={{ fontSize: 11, color: c.textSecondary, fontFamily: "monospace", lineHeight: 18, backgroundColor: c.bgCardElevated, padding: 10, borderRadius: 6, overflow: "hidden" }}>
                    {"brew install kivanccakmak/yaver/yaver\n"}
                    {"yaver auth\n"}
                    {"yaver serve"}
                  </Text>
                  <Text style={{ fontSize: 12, color: c.textMuted, lineHeight: 18, marginTop: 8 }}>
                    2. Sign in here with the same account{"\n"}
                    3. Your machine appears automatically{"\n"}
                    4. Tap it to connect, then create a task
                  </Text>
                </View>
              )}

              <View style={{ height: 1, backgroundColor: c.borderSubtle }} />

              {/* Cloudflare Tunnel */}
              <Pressable onPress={() => setGuideSection(guideSection === "cloudflare" ? null : "cloudflare")}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 10 }}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: c.textPrimary }}>Cloudflare Tunnel</Text>
                  <Text style={{ color: c.textMuted }}>{guideSection === "cloudflare" ? "\u2303" : "\u2304"}</Text>
                </View>
              </Pressable>
              {guideSection === "cloudflare" && (
                <View style={{ paddingBottom: 12 }}>
                  <Text style={{ fontSize: 12, color: c.textMuted, lineHeight: 18, marginBottom: 8 }}>
                    Creates a secure HTTPS path from Cloudflare's edge to your machine. Works through any firewall that allows web browsing.
                  </Text>
                  <Text style={{ fontSize: 11, color: c.textSecondary, fontFamily: "monospace", lineHeight: 18, backgroundColor: c.bgCardElevated, padding: 10, borderRadius: 6, overflow: "hidden" }}>
                    {"# Install cloudflared\n"}
                    {"brew install cloudflared\n\n"}
                    {"# Quick tunnel (testing)\n"}
                    {"cloudflared tunnel --url http://localhost:18080\n\n"}
                    {"# Named tunnel (permanent)\n"}
                    {"cloudflared tunnel create yaver\n"}
                    {"cloudflared tunnel route dns yaver \\\n"}
                    {"  tunnel.yourdomain.com\n"}
                    {"cloudflared tunnel run yaver\n\n"}
                    {"# Register in CLI\n"}
                    {"yaver tunnel add https://tunnel.yourdomain.com"}
                  </Text>
                  <Text style={{ fontSize: 12, color: c.textMuted, lineHeight: 18, marginTop: 8 }}>
                    Then add the same tunnel URL in the Cloudflare Tunnel section above.
                  </Text>
                </View>
              )}

              <View style={{ height: 1, backgroundColor: c.borderSubtle }} />

              {/* Relay server */}
              <Pressable onPress={() => setGuideSection(guideSection === "relay" ? null : "relay")}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 10 }}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: c.textPrimary }}>Self-hosted relay server</Text>
                  <Text style={{ color: c.textMuted }}>{guideSection === "relay" ? "\u2303" : "\u2304"}</Text>
                </View>
              </Pressable>
              {guideSection === "relay" && (
                <View style={{ paddingBottom: 12 }}>
                  <Text style={{ fontSize: 12, color: c.textMuted, lineHeight: 18, marginBottom: 8 }}>
                    Deploy a QUIC relay on any VPS. It's a pass-through proxy — stores nothing, can't read your traffic. Password-protected.
                  </Text>
                  <Text style={{ fontSize: 11, color: c.textSecondary, fontFamily: "monospace", lineHeight: 18, backgroundColor: c.bgCardElevated, padding: 10, borderRadius: 6, overflow: "hidden" }}>
                    {"# One-command setup\n"}
                    {"# (Docker + nginx + Let's Encrypt)\n"}
                    {"./scripts/setup-relay.sh IP DOMAIN \\\n"}
                    {"  --password SECRET\n\n"}
                    {"# Or Docker only\n"}
                    {"cd relay\n"}
                    {"RELAY_PASSWORD=secret \\\n"}
                    {"  docker compose up -d\n\n"}
                    {"# Register in CLI\n"}
                    {"yaver relay add \\\n"}
                    {"  https://relay.yourdomain.com \\\n"}
                    {"  --password secret"}
                  </Text>
                  <Text style={{ fontSize: 12, color: c.textMuted, lineHeight: 18, marginTop: 8 }}>
                    Then add the relay URL and password in the Relay Servers section above.{"\n\n"}
                    Requirements: 1 vCPU, 512 MB RAM, any Linux VPS.
                  </Text>
                </View>
              )}

              <View style={{ height: 1, backgroundColor: c.borderSubtle }} />

              {/* Tailscale */}
              <Pressable onPress={() => setGuideSection(guideSection === "tailscale" ? null : "tailscale")}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 10 }}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: c.textPrimary }}>Tailscale</Text>
                  <Text style={{ color: c.textMuted }}>{guideSection === "tailscale" ? "\u2303" : "\u2304"}</Text>
                </View>
              </Pressable>
              {guideSection === "tailscale" && (
                <View style={{ paddingBottom: 12 }}>
                  <Text style={{ fontSize: 12, color: c.textMuted, lineHeight: 18 }}>
                    If both your phone and machine are on a Tailscale network, no tunnel or relay is needed.{"\n\n"}
                    Install Tailscale on both devices, then run:{"\n"}
                  </Text>
                  <Text style={{ fontSize: 11, color: c.textSecondary, fontFamily: "monospace", lineHeight: 18, backgroundColor: c.bgCardElevated, padding: 10, borderRadius: 6, overflow: "hidden" }}>
                    {"yaver serve --no-relay"}
                  </Text>
                  <Text style={{ fontSize: 12, color: c.textMuted, lineHeight: 18, marginTop: 8 }}>
                    The app connects directly via your Tailscale IP. WireGuard end-to-end encryption, ~5ms latency. Tailscale's DERP servers handle hard NAT automatically.{"\n\n"}
                    Free for personal use (up to 100 devices).
                  </Text>
                </View>
              )}
            </View>
          )}

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
              { label: "Contact", onPress: () => Linking.openURL("mailto:kivanc.cakmak@simkab.com").catch(() => {}) },
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
  scrollContent: { padding: 16, paddingBottom: 120 },

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

  // AI Runner
  runnerOption: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  radioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  runnerName: {
    fontSize: 15,
    fontWeight: "500",
  },
  runnerDesc: {
    fontSize: 12,
    marginTop: 2,
  },
  customRunnerInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 14,
    fontFamily: "monospace",
    marginTop: 8,
    marginLeft: 32,
  },

  deleteAccountButton: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    alignItems: "center",
  },
  deleteAccountText: { fontSize: 14, fontWeight: "600" },

  // Relay input
  relayInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 14,
  },
});

const metricsStyles = StyleSheet.create({
  chartContainer: {
    flexDirection: "row",
    alignItems: "flex-end",
    height: 60,
    gap: 1,
    backgroundColor: "rgba(255,255,255,0.03)",
    borderRadius: 6,
    paddingHorizontal: 2,
    paddingVertical: 2,
    overflow: "hidden",
  },
  bar: {
    flex: 1,
    minWidth: 2,
    borderRadius: 1,
  },
  timeLabels: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
  },
});
