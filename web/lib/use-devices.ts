"use client";

import { useEffect, useState, useCallback } from "react";
import { agentClient, type ConnectionState } from "./agent-client";

const CONVEX_URL = "https://shocking-echidna-394.eu-west-1.convex.site";

export interface Device {
  id: string;
  name: string;
  platform: string;
  host: string;
  port: number;
  lastSeen: string;
  online: boolean;
}

interface DevicesState {
  devices: Device[];
  activeDevice: Device | null;
  connectionStatus: ConnectionState;
  selectDevice: (device: Device) => Promise<void>;
  disconnect: () => void;
  refreshDevices: () => Promise<void>;
}

export function useDevices(token: string | null): DevicesState {
  const [devices, setDevices] = useState<Device[]>([]);
  const [activeDevice, setActiveDevice] = useState<Device | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionState>("disconnected");

  const refreshDevices = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${CONVEX_URL}/devices/list`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = (await res.json()) as Device[];
      setDevices(data);
    } catch {
      // Silently fail -- devices list is non-critical.
    }
  }, [token]);

  const selectDevice = useCallback(
    async (device: Device) => {
      if (!token) return;
      try {
        await agentClient.connect(device.host, device.port, token);
        setActiveDevice(device);
      } catch {
        // Connection failed -- state is tracked via the listener.
        setActiveDevice(device);
      }
    },
    [token],
  );

  const disconnect = useCallback(() => {
    agentClient.disconnect();
    setActiveDevice(null);
    setConnectionStatus("disconnected");
  }, []);

  // Listen to connection state changes
  useEffect(() => {
    const unsub = agentClient.on("connectionState", (state) => {
      setConnectionStatus(state);
    });
    // Sync initial state
    setConnectionStatus(agentClient.connectionState);
    return unsub;
  }, []);

  // Auto-refresh on mount
  useEffect(() => {
    refreshDevices();
  }, [refreshDevices]);

  return {
    devices,
    activeDevice,
    connectionStatus,
    selectDevice,
    disconnect,
    refreshDevices,
  };
}
