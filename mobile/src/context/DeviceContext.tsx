import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import NetInfo from "@react-native-community/netinfo";
import { quicClient, RelayServer } from "../lib/quic";
import { useAuth } from "./AuthContext";

const CONVEX_SITE_URL = "https://shocking-echidna-394.eu-west-1.convex.site";

export interface Device {
  id: string;
  name: string;
  host: string;
  port: number;
  online: boolean;
  lastSeen: number;
  os: string;
}

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

interface DeviceState {
  devices: Device[];
  activeDevice: Device | null;
  connectionStatus: ConnectionStatus;
  isLoadingDevices: boolean;
  selectDevice: (device: Device) => Promise<void>;
  disconnect: () => void;
  refreshDevices: () => Promise<void>;
}

const DeviceContext = createContext<DeviceState | undefined>(undefined);

export function DeviceProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const [devices, setDevices] = useState<Device[]>([]);
  const [activeDevice, setActiveDevice] = useState<Device | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [isLoadingDevices, setIsLoadingDevices] = useState(false);

  const refreshDevices = useCallback(async () => {
    if (!token) return;
    setIsLoadingDevices(true);
    try {
      // Discover devices via Convex / backend
      const res = await fetch("https://shocking-echidna-394.eu-west-1.convex.site/devices/list", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        const raw = data.devices || data || [];
        // Map Convex device fields to our Device interface
        const mapped: Device[] = raw.map((d: any) => ({
          id: d.deviceId || d.id,
          name: d.name,
          host: d.quicHost || d.host,
          port: d.quicPort || d.port,
          online: d.isOnline ?? d.online ?? false,
          lastSeen: d.lastHeartbeat || d.lastSeen || 0,
          os: d.platform || d.os || "",
        }));
        setDevices(mapped);
      }
    } catch {
      // Silently fail — device list stays stale.
    } finally {
      setIsLoadingDevices(false);
    }
  }, [token]);

  // Fetch relay servers from platform config (once)
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
        }
      } catch {
        // Relay config fetch failed — direct connections still work.
      }
    })();
  }, []);

  // Fetch devices when token becomes available
  useEffect(() => {
    if (token) {
      refreshDevices();
    } else {
      setDevices([]);
      setActiveDevice(null);
      setConnectionStatus("disconnected");
    }
  }, [token, refreshDevices]);

  // Auto-connect to the first online device if none is active
  useEffect(() => {
    if (!token || activeDevice || connectionStatus === "connecting") return;
    const onlineDevice = devices.find((d) => d.online);
    if (onlineDevice) {
      selectDevice(onlineDevice);
    }
  }, [devices, token, activeDevice, connectionStatus, selectDevice]);

  // Trigger immediate reconnection on network change (WiFi↔cellular roaming)
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (state.isConnected && activeDevice) {
        // Network came back or switched type — re-probe immediately
        quicClient.triggerReconnect();
      }
    });
    return () => unsubscribe();
  }, [activeDevice]);

  const selectDevice = useCallback(
    async (device: Device) => {
      if (!token) return;

      // Disconnect from current device first
      if (quicClient.isConnected) {
        quicClient.disconnect();
      }

      setConnectionStatus("connecting");
      setActiveDevice(device);

      try {
        await quicClient.connect(device.host, device.port, token, device.id);
        setConnectionStatus("connected");
      } catch {
        setConnectionStatus("error");
      }
    },
    [token]
  );

  const disconnect = useCallback(() => {
    quicClient.disconnect();
    setActiveDevice(null);
    setConnectionStatus("disconnected");
  }, []);

  const value = useMemo<DeviceState>(
    () => ({
      devices,
      activeDevice,
      connectionStatus,
      isLoadingDevices,
      selectDevice,
      disconnect,
      refreshDevices,
    }),
    [devices, activeDevice, connectionStatus, isLoadingDevices, selectDevice, disconnect, refreshDevices]
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
