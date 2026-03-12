"use client";

import { useState, useEffect, useCallback } from "react";
import type { Device } from "@/lib/use-devices";

interface SubscriptionData {
  plan: string;
  status: string;
  renewsAt?: string;
  endsAt?: string;
  variantId?: string;
}

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
  const [subscription, setSubscription] = useState<SubscriptionData | null>(null);
  const [subLoading, setSubLoading] = useState(true);
  const [subActionLoading, setSubActionLoading] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const fetchSubscription = useCallback(async () => {
    try {
      const res = await fetch("/api/subscriptions/status");
      if (res.ok) {
        const data = await res.json();
        setSubscription(data);
      }
    } catch {
      // Subscription status unavailable -- not critical
    } finally {
      setSubLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSubscription();
  }, [fetchSubscription]);

  const handleUpgrade = async () => {
    setSubActionLoading(true);
    try {
      const res = await fetch("/api/subscriptions/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantId: "pro-monthly" }),
      });
      if (res.ok) {
        const { url } = await res.json();
        if (url) {
          window.location.href = url;
          return;
        }
      }
    } catch {
      // Checkout failed
    }
    setSubActionLoading(false);
  };

  const handleManageSubscription = async () => {
    setSubActionLoading(true);
    try {
      const res = await fetch("/api/subscriptions/portal", {
        method: "POST",
      });
      if (res.ok) {
        const { url } = await res.json();
        if (url) {
          window.location.href = url;
          return;
        }
      }
    } catch {
      // Portal failed
    }
    setSubActionLoading(false);
  };

  const handleDeleteAccount = async () => {
    setDeleteLoading(true);
    setDeleteError(null);

    try {
      const convexSiteUrl = "https://shocking-echidna-394.eu-west-1.convex.site";

      // Get the token from localStorage or cookie
      const token =
        localStorage.getItem("yaver_auth_token") ||
        document.cookie
          .split(";")
          .find((c) => c.trim().startsWith("yaver_session="))
          ?.split("=")[1];

      if (!token) {
        setDeleteError("Not authenticated. Please sign in again.");
        setDeleteLoading(false);
        return;
      }

      const res = await fetch(`${convexSiteUrl}/auth/delete-account`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!res.ok) {
        const text = await res.text();
        setDeleteError(text || "Failed to delete account.");
        setDeleteLoading(false);
        return;
      }

      // Clear auth and redirect
      localStorage.removeItem("yaver_auth_token");
      document.cookie = "yaver_auth_token=; path=/; max-age=0; secure; samesite=lax";
      document.cookie = "yaver_session=; path=/; max-age=0; secure; samesite=lax";
      window.location.href = "/";
    } catch {
      setDeleteError("Network error. Please try again.");
      setDeleteLoading(false);
    }
  };

  const isPro = subscription?.plan === "pro" && subscription?.status === "active";

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

        {/* Subscription / Plan */}
        <div className="card mb-4">
          <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-surface-400">
            Subscription
          </h3>

          {subLoading ? (
            <div className="flex items-center gap-2">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-surface-600 border-t-surface-300" />
              <span className="text-sm text-surface-500">Loading...</span>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Current plan */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-surface-400">Current plan</span>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-surface-200">
                    {isPro ? "Pro" : "Early Access"}
                  </span>
                  <span className="inline-flex items-center rounded-full border border-green-800/60 bg-green-950/50 px-2 py-0.5 text-[10px] font-semibold text-green-400">
                    {isPro ? "ACTIVE" : "FREE"}
                  </span>
                </div>
              </div>

              {/* Status details for Pro subscribers */}
              {isPro && subscription?.renewsAt && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-surface-400">Renews on</span>
                  <span className="text-sm text-surface-200">
                    {new Date(subscription.renewsAt).toLocaleDateString()}
                  </span>
                </div>
              )}

              {isPro && subscription?.status === "cancelled" && subscription?.endsAt && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-surface-400">Access until</span>
                  <span className="text-sm text-surface-200">
                    {new Date(subscription.endsAt).toLocaleDateString()}
                  </span>
                </div>
              )}

              {/* Early access notice */}
              {!isPro && (
                <div className="rounded-lg border border-surface-800 bg-surface-850 p-3">
                  <p className="text-xs leading-relaxed text-surface-400">
                    You are on the <span className="text-surface-200">Early Access</span> plan.
                    All features are free during early access, including unlimited devices and
                    tasks. We will give at least 60 days notice before any paid plans begin.
                  </p>
                </div>
              )}

              {/* Action buttons */}
              <div className="pt-1">
                {isPro ? (
                  <button
                    onClick={handleManageSubscription}
                    disabled={subActionLoading}
                    className="w-full rounded-lg border border-surface-700 px-4 py-3 text-sm text-surface-200 transition-colors hover:border-surface-500 hover:text-surface-50 disabled:opacity-50"
                  >
                    {subActionLoading ? "Loading..." : "Manage Subscription"}
                  </button>
                ) : (
                  <button
                    onClick={handleUpgrade}
                    disabled={subActionLoading}
                    className="w-full rounded-lg bg-surface-50 px-4 py-3 text-sm font-medium text-surface-950 transition-colors hover:bg-surface-100 disabled:opacity-50"
                  >
                    {subActionLoading ? "Loading..." : "Upgrade to Pro"}
                  </button>
                )}
              </div>
            </div>
          )}
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
          className="mb-4 w-full rounded-lg border border-red-500/30 px-4 py-3 text-sm text-red-400 transition-colors hover:bg-red-500/10"
        >
          Sign Out
        </button>

        {/* Delete Account */}
        <div className="card mb-4 border-red-500/20">
          <h3 className="mb-2 text-sm font-medium uppercase tracking-wider text-red-400/80">
            Danger Zone
          </h3>
          <p className="mb-4 text-xs text-surface-500">
            Permanently delete your account and all associated data. This action cannot be undone.
          </p>

          {!deleteConfirmOpen ? (
            <button
              onClick={() => setDeleteConfirmOpen(true)}
              className="w-full rounded-lg border border-red-500/30 px-4 py-3 text-sm text-red-400 transition-colors hover:bg-red-500/10"
            >
              Delete Account
            </button>
          ) : (
            <div className="space-y-3">
              <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4">
                <p className="mb-3 text-sm text-red-300">
                  Are you sure? This will permanently delete your account, all devices, and all
                  data. This cannot be undone.
                </p>
                {deleteError && (
                  <p className="mb-3 text-sm text-red-400">{deleteError}</p>
                )}
                <div className="flex gap-3">
                  <button
                    onClick={handleDeleteAccount}
                    disabled={deleteLoading}
                    className="flex-1 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                  >
                    {deleteLoading ? "Deleting..." : "Yes, delete my account"}
                  </button>
                  <button
                    onClick={() => {
                      setDeleteConfirmOpen(false);
                      setDeleteError(null);
                    }}
                    disabled={deleteLoading}
                    className="flex-1 rounded-lg border border-surface-700 px-4 py-2.5 text-sm text-surface-300 transition-colors hover:border-surface-500 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
