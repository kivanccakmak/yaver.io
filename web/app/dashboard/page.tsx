"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Device {
  id: string;
  name: string;
  platform: string;
  lastSeen: string;
  online: boolean;
}

// Placeholder data -- will be replaced with Convex queries
const MOCK_DEVICES: Device[] = [
  {
    id: "1",
    name: "MacBook Pro",
    platform: "macOS",
    lastSeen: "Just now",
    online: true,
  },
  {
    id: "2",
    name: "iPhone 15",
    platform: "iOS",
    lastSeen: "2 minutes ago",
    online: true,
  },
  {
    id: "3",
    name: "Work Desktop",
    platform: "Windows",
    lastSeen: "3 hours ago",
    online: false,
  },
];

function DeviceIcon({ platform }: { platform: string }) {
  if (platform === "iOS" || platform === "Android") {
    return (
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3" />
      </svg>
    );
  }
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25A2.25 2.25 0 015.25 3h13.5A2.25 2.25 0 0121 5.25z" />
    </svg>
  );
}

export default function DashboardPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("yaver_auth_token");
    if (!token) {
      window.location.href = "/auth";
      return;
    }
    setIsAuthenticated(true);

    // TODO: Replace with Convex query
    setDevices(MOCK_DEVICES);
    setLoading(false);
  }, []);

  function handleRemoveDevice(deviceId: string) {
    // TODO: Replace with Convex mutation
    setDevices((prev) => prev.filter((d) => d.id !== deviceId));
  }

  function handleSignOut() {
    localStorage.removeItem("yaver_auth_token");
    document.cookie =
      "yaver_auth_token=; path=/; max-age=0; secure; samesite=lax";
    window.location.href = "/";
  }

  if (loading || !isAuthenticated) {
    return (
      <div className="flex min-h-[80vh] items-center justify-center">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-surface-600 border-t-yaver-500" />
      </div>
    );
  }

  return (
    <div className="px-6 py-20">
      <div className="mx-auto max-w-3xl">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-white">Your Devices</h1>
            <p className="mt-1 text-sm text-surface-400">
              Manage your connected devices.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/download" className="btn-secondary text-sm">
              Add Device
            </Link>
            <button
              onClick={handleSignOut}
              className="rounded-lg px-4 py-2 text-sm text-surface-400 transition-colors hover:text-white"
            >
              Sign Out
            </button>
          </div>
        </div>

        {/* Devices List */}
        {devices.length === 0 ? (
          <div className="card p-12 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-800 text-surface-500">
              <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25A2.25 2.25 0 015.25 3h13.5A2.25 2.25 0 0121 5.25z" />
              </svg>
            </div>
            <h3 className="mb-2 text-lg font-semibold text-white">
              No devices connected
            </h3>
            <p className="mb-6 text-sm text-surface-400">
              Download Yaver on your devices to get started.
            </p>
            <Link href="/download" className="btn-primary">
              Download Yaver
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {devices.map((device) => (
              <div
                key={device.id}
                className="card flex items-center justify-between"
              >
                <div className="flex items-center gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-800 text-surface-400">
                    <DeviceIcon platform={device.platform} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-white">
                        {device.name}
                      </h3>
                      <span
                        className={`inline-flex h-2 w-2 rounded-full ${
                          device.online ? "bg-green-400" : "bg-surface-600"
                        }`}
                      />
                      <span className="text-xs text-surface-500">
                        {device.online ? "Online" : "Offline"}
                      </span>
                    </div>
                    <p className="text-sm text-surface-500">
                      {device.platform} -- Last seen {device.lastSeen}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => handleRemoveDevice(device.id)}
                  className="rounded-lg px-3 py-1.5 text-sm text-surface-500 transition-colors hover:bg-red-500/10 hover:text-red-400"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
