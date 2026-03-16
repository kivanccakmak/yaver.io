import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Platform } from "react-native";
import Constants from "expo-constants";
import NetInfo from "@react-native-community/netinfo";
import { quicClient, RelayServer } from "../lib/quic";
import { useAuth } from "./AuthContext";
import { getUserSettings } from "../lib/auth";
import { appLog } from "../lib/logger";

const APP_VERSION = Constants.expoConfig?.version ?? "unknown";
const BUILD_NUMBER =
  Constants.expoConfig?.ios?.buildNumber ??
  Constants.expoConfig?.android?.versionCode?.toString() ??
  "unknown";

const CONVEX_SITE_URL = "https://shocking-echidna-394.eu-west-1.convex.site";

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
  const { token } = useAuth();
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
        const mapped: Device[] = raw.map((d: any) => ({
          id: d.deviceId || d.id,
          name: d.name,
          host: d.quicHost || d.host,
          port: d.quicPort || d.port,
          online: (() => {
            const flag = d.isOnline ?? d.online ?? false;
            const lastSeen = d.lastHeartbeat || d.lastSeen || 0;
            return flag && lastSeen > 0 && (Date.now() - lastSeen) < HEARTBEAT_STALE_MS;
          })(),
          lastSeen: d.lastHeartbeat || d.lastSeen || 0,
          os: d.platform || d.os || "",
          runners: d.runners ?? [],
        }));
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
          setTimeout(() => reject(new Error("Could not connect in 10s")), 10000)
        );
        await Promise.race([connectPromise, timeoutPromise]);
        sendTelemetry(token, "connect-success", `Connected via ${quicClient.connectionMode}`, device.name);
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
        const gaveUp = quicClient.reconnectAttempt >= 5;
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

  // Fetch relay servers and user settings from platform config (once)
  const relaysFetched = useRef(false);
  useEffect(() => {
    if (relaysFetched.current) return;
    relaysFetched.current = true;
    (async () => {
      try {
        const res = await fetch(`${CONVEX_SITE_URL}/config`);
        if (res.ok) {
          const data = await res.json();
          const servers: RelayServer[] = data.relayServers || [];
          quicClient.setRelayServers(servers);
          console.log("[DeviceContext] Loaded", servers.length, "relay server(s)");
          sendTelemetry(token, "relays-loaded", `Loaded ${servers.length} relay(s)`, JSON.stringify(servers.map(s => s.id)));
        }
      } catch {
        sendTelemetry(token, "relays-failed", "Could not fetch relay config");
      } finally {
        setRelaysReady(true);
      }
    })();
  }, []);

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

  // Fetch devices when token becomes available
  useEffect(() => {
    if (token) {
      refreshDevices();
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
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (state.isConnected && activeDevice) {
        quicClient.triggerReconnect();
      }
    });
    return () => unsubscribe();
  }, [activeDevice]);

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
