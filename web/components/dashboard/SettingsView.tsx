"use client";

import type { Device } from "@/lib/use-devices";

interface SettingsViewProps {
  user: {
    id: string;
    email: string;
    name?: string;
    provider?: string;
    avatarUrl?: string;
  } | null;
  activeDevice: Device | null;
  onLogout: () => void;
}

export default function SettingsView({ user, activeDevice, onLogout }: SettingsViewProps) {
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl">
        <h2 className="mb-6 text-lg font-semibold text-surface-50">Settings</h2>

        {/* Profile */}
        <div className="card mb-4">
          <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-surface-400">
            Profile
          </h3>
          <div className="space-y-3">
            {user?.email && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-surface-400">Email</span>
                <span className="text-sm text-surface-200">{user.email}</span>
              </div>
            )}
            {user?.name && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-surface-400">Name</span>
                <span className="text-sm text-surface-200">{user.name}</span>
              </div>
            )}
            {user?.provider && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-surface-400">Sign-in provider</span>
                <span className="text-sm text-surface-200 capitalize">{user.provider}</span>
              </div>
            )}
          </div>
        </div>

        {/* Connected device */}
        <div className="card mb-4">
          <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-surface-400">
            Connected Device
          </h3>
          {activeDevice ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-surface-400">Name</span>
                <span className="text-sm text-surface-200">{activeDevice.name}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-surface-400">Platform</span>
                <span className="text-sm text-surface-200">{activeDevice.platform}</span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-surface-500">No device connected.</p>
          )}
        </div>

        {/* Links */}
        <div className="card mb-4">
          <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-surface-400">
            Legal
          </h3>
          <div className="space-y-2">
            <a
              href="https://yaver.io/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="block text-sm text-surface-400 transition-colors hover:text-surface-50"
            >
              Privacy Policy
            </a>
            <a
              href="https://yaver.io/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="block text-sm text-surface-400 transition-colors hover:text-surface-50"
            >
              Terms of Service
            </a>
            <a
              href="https://docs.yaver.io"
              target="_blank"
              rel="noopener noreferrer"
              className="block text-sm text-surface-400 transition-colors hover:text-surface-50"
            >
              Documentation
            </a>
          </div>
        </div>

        {/* Sign out */}
        <button
          onClick={onLogout}
          className="w-full rounded-lg border border-red-500/30 px-4 py-3 text-sm text-red-400 transition-colors hover:bg-red-500/10"
        >
          Sign Out
        </button>
      </div>
    </div>
  );
}
