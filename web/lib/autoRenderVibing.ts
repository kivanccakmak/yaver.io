"use client";

import { useCallback, useEffect, useState } from "react";
import { CONVEX_URL } from "@/lib/constants";
import { autoRenderVibingFromSettings } from "@/lib/autoRenderVibingPolicy";

export { autoRenderVibingFromSettings, isExplicitRenderPrompt } from "@/lib/autoRenderVibingPolicy";

const CHANGE_EVENT = "yaver:auto-render-vibing-changed";

function authToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("yaver_auth_token") || null;
}

export function useAutoRenderVibing(): {
  enabled: boolean;
  loaded: boolean;
  save: (enabled: boolean) => Promise<void>;
} {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const token = authToken();
    if (!token) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    void fetch(`${CONVEX_URL}/settings`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`settings ${response.status}`);
        return response.json();
      })
      .then((payload) => {
        if (!cancelled) setEnabled(autoRenderVibingFromSettings(payload?.settings));
      })
      .catch(() => {
        // Default-off is the safe failure mode: a settings outage must never
        // grant permission to replace a working preview.
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    const onChange = (event: Event) => setEnabled((event as CustomEvent<boolean>).detail === true);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(CHANGE_EVENT, onChange);
    };
  }, []);

  const save = useCallback(async (next: boolean) => {
    const token = authToken();
    if (!token) throw new Error("Sign in again to save this setting.");
    const response = await fetch(`${CONVEX_URL}/settings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ autoRenderVibing: next }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error || `Could not save setting (${response.status}).`);
    }
    setEnabled(next);
    window.dispatchEvent(new CustomEvent<boolean>(CHANGE_EVENT, { detail: next }));
  }, []);

  return { enabled, loaded, save };
}
