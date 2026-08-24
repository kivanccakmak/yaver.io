"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { CONVEX_URL } from "@/lib/constants";

type Theme = "light" | "dark";

const ThemeContext = createContext<{
  theme: Theme;
  toggle: () => void;
  setTheme: (theme: Theme) => void;
}>({ theme: "dark", toggle: () => {}, setTheme: () => {} });

export function useTheme() {
  return useContext(ThemeContext);
}

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>("dark");
  const [mounted, setMounted] = useState(false);
  const localMutation = useRef(0);

  useEffect(() => {
    const stored = localStorage.getItem("theme") as Theme | null;
    if (stored) {
      setTheme(stored);
    }
    // Default is dark — no system preference override
    setMounted(true);
  }, []);

  // Convex is authoritative once signed in; localStorage remains the instant
  // paint/offline cache. Per-surface rows let web be light without forcing a
  // phone or TV out of its own preference.
  useEffect(() => {
    if (!mounted) return;
    const token = localStorage.getItem("yaver_auth_token");
    if (!token) return;
    const startedAtMutation = localMutation.current;
    const controller = new AbortController();
    void fetch(`${CONVEX_URL}/settings`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok || localMutation.current !== startedAtMutation) return;
      const data = await response.json();
      const row = data?.settings?.appearanceThemeBySurface?.find?.(
        (item: { surface?: string }) => item.surface === "web",
      );
      if (row?.theme === "light" || row?.theme === "dark") setTheme(row.theme);
    }).catch(() => {
      // Offline keeps the cached local preference; appearance is never a gate.
    });
    return () => controller.abort();
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return;
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    localStorage.setItem("theme", theme);
  }, [theme, mounted]);

  const chooseTheme = useCallback((next: Theme) => {
    localMutation.current += 1;
    setTheme(next);
    const token = localStorage.getItem("yaver_auth_token");
    if (!token) return;
    void fetch(`${CONVEX_URL}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ appearanceThemeForSurface: { surface: "web", theme: next } }),
    }).catch(() => {
      // The local cache keeps the UI usable offline. A later signed-in load
      // reconciles with the last value Convex successfully stored.
    });
  }, []);

  const toggle = useCallback(() => chooseTheme(theme === "dark" ? "light" : "dark"), [chooseTheme, theme]);

  return (
    <ThemeContext.Provider value={{ theme, toggle, setTheme: chooseTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
