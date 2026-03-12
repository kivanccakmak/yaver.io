"use client";

import Link from "next/link";
import type { Device } from "@/lib/use-devices";
import type { ConnectionState } from "@/lib/agent-client";

function DeviceIcon({ platform }: { platform: string }) {
  const isMobile = platform === "iOS" || platform === "Android";
  if (isMobile) {
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

interface DevicesViewProps {
  devices: Device[];
  activeDevice: Device | null;
  connectionStatus: ConnectionState;
  onSelectDevice: (device: Device) => Promise<void>;
  onDisconnect: () => void;
  onRefresh: () => Promise<void>;
}

export default function DevicesView({
  devices,
  activeDevice,
  connectionStatus,
  onSelectDevice,
  onDisconnect,
  onRefresh,
}: DevicesViewProps) {
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-surface-50">Devices</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onRefresh()}
              className="btn-secondary px-3 py-1.5 text-xs"
            >
              Refresh
            </button>
            <Link href="/download" className="btn-secondary px-3 py-1.5 text-xs">
              Add Device
            </Link>
          </div>
        </div>

        {devices.length === 0 ? (
          <div className="card p-12 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-800 text-surface-500">
              <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25A2.25 2.25 0 015.25 3h13.5A2.25 2.25 0 0121 5.25z" />
              </svg>
            </div>
            <h3 className="mb-2 text-lg font-semibold text-surface-50">No devices found</h3>
            <p className="mb-6 text-sm text-surface-400">
              Download Yaver on your devices to get started.
            </p>
            <Link href="/download" className="btn-primary">
              Download Yaver
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {devices.map((device) => {
              const isActive = activeDevice?.id === device.id;
              const isConnecting = isActive && connectionStatus === "connecting";

              return (
                <div key={device.id} className="card flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-800 text-surface-400">
                      <DeviceIcon platform={device.platform} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-surface-50">
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

                  <div>
                    {isActive ? (
                      <button
                        onClick={onDisconnect}
                        className="rounded-lg border border-red-500/30 px-4 py-1.5 text-sm text-red-400 transition-colors hover:bg-red-500/10"
                      >
                        Disconnect
                      </button>
                    ) : (
                      <button
                        onClick={() => onSelectDevice(device)}
                        disabled={!device.online || isConnecting}
                        className="btn-secondary px-4 py-1.5 text-sm disabled:opacity-50"
                      >
                        {isConnecting ? "Connecting..." : "Connect"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
