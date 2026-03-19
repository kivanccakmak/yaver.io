"use client";

import { useAuth } from "@/lib/use-auth";
import { useDevices } from "@/lib/use-devices";
import DevicesView from "@/components/dashboard/DevicesView";
import RelayServerView from "@/components/dashboard/RelayServerView";
import SettingsView from "@/components/dashboard/SettingsView";
import TwoFactorView from "@/components/dashboard/TwoFactorView";

export default function DashboardPage() {
  const { user, token, isLoading, isAuthenticated, logout } = useAuth();
  const { devices, refreshDevices } = useDevices(token);

  // Redirect to auth if not authenticated
  if (!isLoading && !isAuthenticated) {
    if (typeof window !== "undefined") {
      window.location.href = "/auth";
    }
    return null;
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[80vh] items-center justify-center">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-surface-600 border-t-surface-50" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-8">
      <div className="mx-auto max-w-2xl px-6">
        {/* Account Info */}
        <div className="card mb-6">
          <h2 className="mb-4 text-lg font-semibold text-surface-50">Account</h2>
          <div className="flex items-center gap-4">
            {user?.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt=""
                className="h-12 w-12 rounded-full"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-800 text-sm font-medium text-surface-400">
                {user?.email?.charAt(0).toUpperCase() || "?"}
              </div>
            )}
            <div className="min-w-0 flex-1">
              {user?.name && (
                <p className="text-sm font-medium text-surface-50">{user.name}</p>
              )}
              <p className="truncate text-sm text-surface-400">{user?.email}</p>
              {user?.provider && (
                <p className="mt-0.5 text-xs text-surface-500">
                  Signed in with <span className="capitalize">{user.provider}</span>
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Devices */}
        <DevicesView devices={devices} onRefresh={refreshDevices} />

        {/* Relay Server */}
        <RelayServerView token={token} />

        {/* Two-Factor Authentication */}
        <TwoFactorView token={token} />

        {/* Account Actions */}
        <SettingsView user={user} onLogout={logout} />
      </div>
    </div>
  );
}
