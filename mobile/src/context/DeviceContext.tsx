import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { quicClient } from "../lib/quic";
import { useAuth } from "./AuthContext";

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
        setDevices((data.devices || data) as Device[]);
      }
    } catch {
      // Silently fail — device list stays stale.
    } finally {
      setIsLoadingDevices(false);
    }
  }, [token]);

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
        await quicClient.connect(device.host, device.port, token);
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
