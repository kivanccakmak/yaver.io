import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Alert, Linking, Platform } from "react-native";
import Constants from "expo-constants";
import NetInfo from "@react-native-community/netinfo";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import { quicClient, RelayServer, TunnelServer } from "../lib/quic";
import { useAuth } from "./AuthContext";
import { getUserSettings } from "../lib/auth";
import { appLog } from "../lib/logger";
import { beaconListener } from "../lib/beacon";
import { CONVEX_SITE_URL } from "../lib/constants";

/** User-scoped storage key. Falls back to global key if no userId. */
function userKey(userId: string | undefined, key: string): string {
  return userId ? `@yaver/u/${userId}/${key}` : `@yaver/${key}`;
}

// Exported so settings screen can read/write with user scope
export function customRelaysKey(userId?: string): string { return userKey(userId, "custom_relays"); }
export function customTunnelsKey(userId?: string): string { return userKey(userId, "custom_tunnels"); }
function relayOnboardingKey(userId?: string): string { return userKey(userId, "relay_onboarding_done"); }
function relaySyncKey(userId?: string): string { return userKey(userId, "relay_sync_enabled"); }
function debugLogsKey(): string { return "@yaver/debug_logs_enabled"; } // global, not per-user

// Legacy keys for migration
export const CUSTOM_RELAYS_KEY = "@yaver/custom_relays";
export const CUSTOM_TUNNELS_KEY = "@yaver/custom_tunnels";
const RELAY_ONBOARDING_KEY = "@yaver/relay_onboarding_done";

let _debugLogsEnabled = false;
// Load debug preference on module init
AsyncStorage.getItem("@yaver/debug_logs_enabled").then((val) => {
  _debugLogsEnabled = val === "true";
});

const APP_VERSION = Constants.expoConfig?.version ?? "unknown";
const BUILD_NUMBER =
  Constants.expoConfig?.ios?.buildNumber ??
  Constants.expoConfig?.android?.versionCode?.toString() ??
  "unknown";

// Heartbeat is sent every 2 minutes; consider "recently active" if within 5 min
const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

export interface RunnerInfo {
  taskId: string;
  runnerId: string;
  model?: string;
  pid: number;
  status: string;
  title: string;
}

export interface Device {
  id: string;
  name: string;
  host: string;
  port: number;
  online: boolean;
  lastSeen: number;
  os: string;
  runners: RunnerInfo[];
  /** true when device is discovered via LAN beacon (same network) */
  local?: boolean;
}

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

interface DeviceState {
  devices: Device[];
  activeDevice: Device | null;
  connectionStatus: ConnectionStatus;
  isLoadingDevices: boolean;
  /** true when user explicitly disconnected (not a network failure) */
  userDisconnected: boolean;
  /** Last connection error message (null if no error) */
  lastError: string | null;
  selectDevice: (device: Device) => Promise<void>;
  disconnect: () => void;
  refreshDevices: () => Promise<void>;
}

const DeviceContext = createContext<DeviceState | undefined>(undefined);

/** Fire-and-forget telemetry to Convex + in-app logger (best-effort, never throws). */
function sendTelemetry(token: string | null, step: string, message: string, details?: string) {
  const level = step.includes("fail") ? "error" : "info";
  appLog(level as "info" | "error", `[${step}] ${message}${details ? " | " + details : ""}`);
  if (!_debugLogsEnabled) return;
  fetch(`${CONVEX_SITE_URL}/mobile/log`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({
      level, step, message,
      details: details?.slice(0, 2000),
      platform: Platform.OS,
      appVersion: APP_VERSION,
      buildNumber: BUILD_NUMBER,
    }),
  }).catch(() => {});
}

export function DeviceProvider({ children }: { children: React.ReactNode }) {
  const { token, user } = useAuth();
  const uid = user?.id;

  // User-scoped storage keys (different user = different settings)
  const RELAYS_KEY = customRelaysKey(uid);
  const TUNNELS_KEY = customTunnelsKey(uid);
  const ONBOARDING_KEY = relayOnboardingKey(uid);
  const SYNC_KEY = relaySyncKey(uid);

  // Migrate legacy global keys to user-scoped on first load
  const migrated = useRef(false);
  useEffect(() => {
    if (!uid || migrated.current) return;
    migrated.current = true;
    (async () => {
      // Migrate relays
      const scopedRelays = await AsyncStorage.getItem(RELAYS_KEY);
      if (!scopedRelays) {
        const legacy = await AsyncStorage.getItem(CUSTOM_RELAYS_KEY);
        if (legacy) await AsyncStorage.setItem(RELAYS_KEY, legacy);
      }
      // Migrate tunnels
      const scopedTunnels = await AsyncStorage.getItem(TUNNELS_KEY);
      if (!scopedTunnels) {
        const legacy = await AsyncStorage.getItem(CUSTOM_TUNNELS_KEY);
        if (legacy) await AsyncStorage.setItem(TUNNELS_KEY, legacy);
      }
    })().catch(() => {});
  }, [uid, RELAYS_KEY, TUNNELS_KEY]);

  const [devices, setDevices] = useState<Device[]>([]);
  const [activeDevice, setActiveDevice] = useState<Device | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [isLoadingDevices, setIsLoadingDevices] = useState(false);
  const [userDisconnected, setUserDisconnected] = useState(false);
  const [relaysReady, setRelaysReady] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const hasLoadedOnce = useRef(false);

  const refreshDevices = useCallback(async () => {
    if (!token) {
      appLog("info", "refreshDevices: no token, skipping");
      return;
    }
    appLog("info", "refreshDevices: fetching...");
    // Only show loading spinner on initial load, not background refreshes
    if (!hasLoadedOnce.current) {
      setIsLoadingDevices(true);
    }
    try {
      // Fetch devices and settings in parallel
      const [devicesRes, settings] = await Promise.all([
        fetch(`${CONVEX_SITE_URL}/devices/list`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        getUserSettings(token),
      ]);
      appLog("info", `/devices/list status: ${devicesRes.status}`);

      // Apply forceRelay setting
      if (settings.forceRelay !== undefined) {
        quicClient.setForceRelay(settings.forceRelay);
      }

      if (devicesRes.ok) {
        const data = await devicesRes.json();
        const raw = data.devices || data || [];
        appLog("info", `Found ${raw.length} device(s)`);
        const connectedDeviceId = quicClient.isConnected ? activeDevice?.id : null;
        const mapped: Device[] = raw.map((d: any) => {
          const deviceId = d.deviceId || d.id;
          // If we're actively connected to this device, trust our connection over stale heartbeat
          const isActivelyConnected = connectedDeviceId === deviceId;
          return {
            id: deviceId,
            name: d.name,
            host: d.quicHost || d.host,
            port: d.quicPort || d.port,
            online: isActivelyConnected || (() => {
              const flag = d.isOnline ?? d.online ?? false;
              const lastSeen = d.lastHeartbeat || d.lastSeen || 0;
              return flag && lastSeen > 0 && (Date.now() - lastSeen) < HEARTBEAT_STALE_MS;
            })(),
            lastSeen: isActivelyConnected ? Date.now() : (d.lastHeartbeat || d.lastSeen || 0),
            os: d.platform || d.os || "",
            runners: d.runners ?? [],
          };
        });
        // Deduplicate by name — keep the entry with the latest lastSeen
        const seen = new Map<string, Device>();
        for (const d of mapped) {
          const existing = seen.get(d.name);
          if (!existing || d.lastSeen > existing.lastSeen) seen.set(d.name, d);
        }
        setDevices([...seen.values()]);
      } else {
        appLog("warn", `/devices/list failed: ${devicesRes.status}`);
      }
    } catch (e) {
      appLog("error", `refreshDevices error: ${e}`);
    } finally {
      hasLoadedOnce.current = true;
      setIsLoadingDevices(false);
    }
  }, [token]);

  const selectDevice = useCallback(
    async (device: Device) => {
      if (!token) return;

      // Clear user-disconnect flag when user (or auto-connect) selects a device
      setUserDisconnected(false);
      setLastError(null);

      if (quicClient.isConnected) {
        quicClient.disconnect();
      }

      setConnectionStatus("connecting");
      setActiveDevice(device);

      try {
        sendTelemetry(token, "connect-start", `Connecting to ${device.name}`, JSON.stringify({
          host: device.host, port: device.port, deviceId: device.id.slice(0, 8),
          relayCount: quicClient.relayServerCount,
        }));
        // Race connect against a 10s timeout
        const connectPromise = quicClient.connect(device.host, device.port, token, device.id);
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Could not connect in 20s")), 20000)
        );
        await Promise.race([connectPromise, timeoutPromise]);
        sendTelemetry(token, "connect-success", `Connected via ${quicClient.connectionMode}`, JSON.stringify({
          device: device.name, path: quicClient.connectionPath, network: quicClient.networkType, mode: quicClient.connectionMode,
        }));
        setConnectionStatus("connected");
        setLastError(null);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        sendTelemetry(token, "connect-fail", `Connection failed: ${errMsg}`, JSON.stringify({
          host: device.host, port: device.port, deviceId: device.id.slice(0, 8),
          relayCount: quicClient.relayServerCount,
        }));
        // Stop any background reconnection attempts
        quicClient.disconnect();
        setConnectionStatus("disconnected");
        setActiveDevice(null);
        setLastError(errMsg);
      }
    },
    [token]
  );

  const disconnect = useCallback(() => {
    quicClient.disconnect();
    setActiveDevice(null);
    setConnectionStatus("disconnected");
    setUserDisconnected(true);
  }, []);

  // Sync DeviceContext state with QUIC client's internal state changes
  // (e.g., polling failures trigger reconnection inside the QUIC client)
  useEffect(() => {
    const unsub = quicClient.on("connectionState", (state) => {
      // Only sync if we have an active device (i.e., we initiated a connection)
      if (!activeDevice) return;

      if (state === "connected") {
        setConnectionStatus("connected");
        setLastError(null);
      } else if (state === "connecting") {
        setConnectionStatus("connecting");
      } else if (state === "error") {
        const gaveUp = quicClient.reconnectAttempt >= 15;
        if (gaveUp) {
          quicClient.disconnect();
          setConnectionStatus("disconnected");
          setActiveDevice(null);
          setLastError("Could not connect to device");
        } else {
          setConnectionStatus("error");
          setLastError("Connection lost — reconnecting...");
        }
      } else if (state === "disconnected") {
        // QUIC client fully disconnected (e.g., via disconnect() call)
        // Don't clear activeDevice here — that's handled by the disconnect() callback
      }
    });
    return () => unsub();
  }, [activeDevice]);

  // Fetch relay servers: local AsyncStorage > Convex user settings > Convex platform config
  const relaysFetched = useRef(false);
  useEffect(() => {
    if (relaysFetched.current) return;
    relaysFetched.current = true;
    (async () => {
      try {
        // 1. Check for user-configured custom relays in local storage first
        const customRaw = await AsyncStorage.getItem(RELAYS_KEY);
        if (customRaw) {
          const customRelays: RelayServer[] = JSON.parse(customRaw);
          if (customRelays.length > 0) {
            quicClient.setRelayServers(customRelays);
            console.log("[DeviceContext] Using", customRelays.length, "custom relay server(s)");
            sendTelemetry(token, "relays-loaded", `Loaded ${customRelays.length} custom relay(s)`, JSON.stringify(customRelays.map(s => s.id)));
            return;
          }
        }

        // 2. No local relays — check Convex user settings (account-level relay config)
        if (token) {
          try {
            const settings = await getUserSettings(token);
            if (settings.relayUrl) {
              const accountRelay: RelayServer = {
                id: "account",
                quicAddr: "",
                httpUrl: settings.relayUrl,
                region: "account",
                priority: 1,
                password: settings.relayPassword,
              };
              quicClient.setRelayServers([accountRelay]);
              // Persist to AsyncStorage so it works offline and on next launch
              await AsyncStorage.setItem(RELAYS_KEY, JSON.stringify([accountRelay]));
              // Also enable relay sync so future changes propagate
              await AsyncStorage.setItem(SYNC_KEY, "true");
              console.log("[DeviceContext] Loaded relay from Convex user settings:", settings.relayUrl);
              sendTelemetry(token, "relays-loaded", "Loaded relay from account settings", settings.relayUrl);
              return;
            }
          } catch {
            // Best-effort — fall through to platform config
          }
        }

        // 3. No account-level relay — fall back to Convex platform config
        const res = await fetch(`${CONVEX_SITE_URL}/config`);
        if (res.ok) {
          const data = await res.json();
          const servers: RelayServer[] = data.relayServers || [];
          quicClient.setRelayServers(servers);
          console.log("[DeviceContext] Loaded", servers.length, "relay server(s) from Convex");
          sendTelemetry(token, "relays-loaded", `Loaded ${servers.length} relay(s) from Convex`, JSON.stringify(servers.map(s => s.id)));
        }
      } catch {
        sendTelemetry(token, "relays-failed", "Could not fetch relay config");
      } finally {
        setRelaysReady(true);
      }
    })();
  }, [token]);

  // Fetch Cloudflare Tunnels from local storage or Convex user settings
  const tunnelsFetched = useRef(false);
  useEffect(() => {
    if (tunnelsFetched.current) return;
    tunnelsFetched.current = true;
    (async () => {
      try {
        // 1. Check local storage first
        const customRaw = await AsyncStorage.getItem(TUNNELS_KEY);
        if (customRaw) {
          const customTunnels: TunnelServer[] = JSON.parse(customRaw);
          if (customTunnels.length > 0) {
            quicClient.setTunnelServers(customTunnels);
            console.log("[DeviceContext] Using", customTunnels.length, "custom tunnel(s)");
            return;
          }
        }

        // 2. Check Convex user settings for synced tunnel URL
        if (token) {
          try {
            const settings = await getUserSettings(token);
            if (settings.tunnelUrl) {
              const accountTunnel: TunnelServer = {
                id: "account",
                url: settings.tunnelUrl,
                priority: 1,
              };
              quicClient.setTunnelServers([accountTunnel]);
              await AsyncStorage.setItem(TUNNELS_KEY, JSON.stringify([accountTunnel]));
              console.log("[DeviceContext] Loaded tunnel from Convex user settings:", settings.tunnelUrl);
            }
          } catch {
            // Best-effort
          }
        }
      } catch {
        // Best-effort
      }
    })();
  }, [token]);

  // Load user settings (forceRelay) on startup
  const settingsLoaded = useRef(false);
  useEffect(() => {
    if (!token || settingsLoaded.current) return;
    settingsLoaded.current = true;
    getUserSettings(token).then((s) => {
      if (s.forceRelay !== undefined) {
        quicClient.setForceRelay(s.forceRelay);
        appLog("info", `[settings] forceRelay=${s.forceRelay}`);
      }
    });
  }, [token]);

  // One-time relay onboarding alert after first login
  const onboardingChecked = useRef(false);
  useEffect(() => {
    if (!token || !relaysReady || onboardingChecked.current) return;
    onboardingChecked.current = true;
    (async () => {
      try {
        const done = await AsyncStorage.getItem(ONBOARDING_KEY);
        if (done) return;
        const customRaw = await AsyncStorage.getItem(RELAYS_KEY);
        if (customRaw) {
          const parsed = JSON.parse(customRaw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            // Already has custom relays, skip onboarding
            await AsyncStorage.setItem(ONBOARDING_KEY, "1");
            return;
          }
        }
        Alert.alert(
          "Relay Server Setup",
          "A relay server lets you connect to your dev machine from anywhere. " +
          "If you're always on the same WiFi or use Tailscale, you can skip this.",
          [
            {
              text: "Set Up Relay",
              onPress: () => {
                AsyncStorage.setItem(ONBOARDING_KEY, "1");
                router.push("/(tabs)/settings");
              },
            },
            {
              text: "Learn More",
              onPress: () => {
                Linking.openURL("https://yaver.io/docs/self-hosting");
              },
            },
            {
              text: "Skip",
              style: "cancel",
              onPress: () => {
                AsyncStorage.setItem(ONBOARDING_KEY, "1");
              },
            },
          ]
        );
      } catch {
        // Best-effort
      }
    })();
  }, [token, relaysReady]);

  // Start/stop LAN beacon listener based on auth state
  useEffect(() => {
    if (user?.id) {
      beaconListener.setUserId(user.id).then(() => {
        beaconListener.start();
      });
    }
    return () => {
      beaconListener.stop();
    };
  }, [user?.id]);

  // Feed known device IDs to beacon listener for matching
  useEffect(() => {
    if (devices.length > 0) {
      beaconListener.setKnownDevices(devices.map((d) => d.id));
    }
  }, [devices]);

  // When beacon discovers/loses a device, update device list
  useEffect(() => {
    const unsubDiscover = beaconListener.onDiscovered((discovered) => {
      setDevices((prev) =>
        prev.map((d) => {
          if (d.id.startsWith(discovered.deviceId)) {
            return { ...d, host: discovered.ip, port: discovered.port, online: true, local: true };
          }
          return d;
        })
      );
      sendTelemetry(token, "peer-matched", `${discovered.name} at ${discovered.ip}:${discovered.port}`, discovered.deviceId);
    });

    const unsubLost = beaconListener.onLost((deviceId) => {
      setDevices((prev) =>
        prev.map((d) => {
          if (d.id.startsWith(deviceId)) {
            return { ...d, local: false };
          }
          return d;
        })
      );
      sendTelemetry(token, "peer-lost", `Device ${deviceId} beacon lost`);
    });

    return () => { unsubDiscover(); unsubLost(); };
  }, [token]);

  // Fetch devices when token becomes available + auto-poll every 3s
  useEffect(() => {
    if (token) {
      refreshDevices();
      // Poll every 3s so device status changes are picked up from any screen
      const interval = setInterval(refreshDevices, 3000);
      return () => clearInterval(interval);
    } else {
      setDevices([]);
      setActiveDevice(null);
      setConnectionStatus("disconnected");
      setUserDisconnected(false);
    }
  }, [token, refreshDevices]);

  // Auto-connect: single online device → connect immediately (unless user disconnected)
  // Wait for relaysReady so the QUIC client has relay servers before attempting connection
  useEffect(() => {
    if (!token || !relaysReady || activeDevice || connectionStatus === "connecting" || userDisconnected) return;

    const recentDevices = devices.filter((d) => d.online);

    if (recentDevices.length === 1) {
      console.log("[DeviceContext] Auto-connecting to single online device:", recentDevices[0].name);
      sendTelemetry(token, "auto-connect", `Single device: ${recentDevices[0].name}`, JSON.stringify({
        relayCount: quicClient.relayServerCount, deviceId: recentDevices[0].id.slice(0, 8),
      }));
      selectDevice(recentDevices[0]);
    }
    // Multiple devices → don't auto-connect, let UI prompt user
  }, [devices, token, relaysReady, activeDevice, connectionStatus, userDisconnected, selectDevice]);

  // Trigger immediate reconnection on network change (WiFi↔cellular roaming)
  useEffect(() => {
    let lastType: string | null = null;
    const unsubscribe = NetInfo.addEventListener((state) => {
      const currentType = state.type; // "wifi", "cellular", "none", etc.

      if (state.isConnected && activeDevice) {
        // Trigger full reconnect on network type change (WiFi → cellular, cellular → WiFi)
        // This clears stale relay URLs and re-probes all paths from scratch
        if (lastType && lastType !== currentType) {
          console.log(`[DeviceContext] Network changed: ${lastType} → ${currentType}`);
          sendTelemetry(token, "network-change", `${lastType} → ${currentType}`);
          quicClient.fullReconnect();
        } else if (!lastType) {
          // First event after mount or reconnection — just probe to be safe
          quicClient.triggerReconnect();
        }
      }
      lastType = currentType;
    });
    return () => unsubscribe();
  }, [activeDevice, token]);

  const value = useMemo<DeviceState>(
    () => ({
      devices,
      activeDevice,
      connectionStatus,
      isLoadingDevices,
      userDisconnected,
      lastError,
      selectDevice,
      disconnect,
      refreshDevices,
    }),
    [devices, activeDevice, connectionStatus, isLoadingDevices, userDisconnected, lastError, selectDevice, disconnect, refreshDevices]
  );

  return <DeviceContext.Provider value={value}>{children}</DeviceContext.Provider>;
}

export function useDevice(): DeviceState {
  const ctx = useContext(DeviceContext);
  if (!ctx) {
    throw new Error("useDevice must be used within a DeviceProvider");
  }
  return ctx;
}
