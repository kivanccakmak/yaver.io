import * as SecureStore from "expo-secure-store";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  DarkColors,
  LightColors,
  type ThemeColors,
} from "../constants/colors";

const THEME_KEY = "yaver_theme";

interface ThemeContextType {
  colors: ThemeColors;
  isDark: boolean;
  toggleTheme: () => void;
  setTheme: (theme: "light" | "dark") => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    SecureStore.getItemAsync(THEME_KEY).then((val) => {
      if (val === "light") setIsDark(false);
      if (val === "dark") setIsDark(true);
    }).catch(() => {});
  }, []);

  const toggleTheme = useCallback(() => {
    setIsDark((prev) => {
      const next = !prev;
      SecureStore.setItemAsync(THEME_KEY, next ? "dark" : "light").catch(() => {});
      return next;
    });
  }, []);

  const setTheme = useCallback((theme: "light" | "dark") => {
    const dark = theme === "dark";
    setIsDark(dark);
    SecureStore.setItemAsync(THEME_KEY, theme).catch(() => {});
  }, []);

  const value = useMemo<ThemeContextType>(
    () => ({
      colors: isDark ? DarkColors : LightColors,
      isDark,
      toggleTheme,
      setTheme,
    }),
    [isDark, toggleTheme, setTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextType {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

export function useColors(): ThemeColors {
  return useTheme().colors;
}
