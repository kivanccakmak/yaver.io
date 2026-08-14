"use client";

import { useEffect, useState, useCallback } from "react";
import { CONVEX_URL } from "@/lib/constants";

export interface Device {
  deviceId: string;
  id: string;
  name: string;
  platform: string;
  host: string;
  port: number;
  lastSeen: string;
  online: boolean;
  runnerDown?: boolean;
  runners?: Array<{ taskId: string; runnerId: string; status: string; title: string }>;
}

interface DevicesState {
  devices: Device[];
  refreshDevices: () => Promise<void>;
}

export function useDevices(token: string | null): DevicesState {
  const [devices, setDevices] = useState<Device[]>([]);

  const refreshDevices = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${CONVEX_URL}/devices/list`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { devices?: Array<Record<string, unknown>> };
      setDevices((data.devices ?? []).map((device) => ({
        deviceId: String(device.deviceId ?? device.id ?? ""),
        id: String(device.deviceId ?? device.id ?? ""),
        name: String(device.name ?? "Unnamed device"),
        platform: String(device.platform ?? "unknown"),
        host: String(device.quicHost ?? device.host ?? "127.0.0.1"),
        port: Number(device.quicPort ?? device.port ?? 18080),
        lastSeen: String(device.lastHeartbeat ?? device.lastSeen ?? ""),
        online: Boolean(device.isOnline ?? device.online),
        runnerDown: Boolean(device.runnerDown),
        runners: Array.isArray(device.runners) ? device.runners as Device["runners"] : [],
      })));
    } catch {
      // Silently fail -- devices list is non-critical.
    }
  }, [token]);

  // Auto-refresh on mount
  useEffect(() => {
    refreshDevices();
  }, [refreshDevices]);

  return {
    devices,
    refreshDevices,
  };
}
