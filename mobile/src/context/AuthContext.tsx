import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { AppState, AppStateStatus } from "react-native";
import {
  User,
  getToken,
  getUser,
  saveToken,
  saveUser,
  clearToken,
  validateToken,
  refreshToken,
  getSurveyStatus,
  clearKeychainIfFreshInstall,
  getConvexSiteUrl,
} from "../lib/auth";
import { clearCache } from "../lib/storage";

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  surveyCompleted: boolean;
  login: (token: string) => Promise<void>;
  logout: () => Promise<void>;
  markSurveyCompleted: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [surveyCompleted, setSurveyCompleted] = useState(false);

  // Restore session on mount
  useEffect(() => {
    (async () => {
      try {
        // Wipe stale Keychain tokens on fresh install (iOS Keychain survives uninstall)
        await clearKeychainIfFreshInstall();
        const storedToken = await getToken();
        if (storedToken) {
          // Always validate token remotely to ensure session is still valid
          const validatedUser = await validateToken(storedToken);
          if (validatedUser) {
            setToken(storedToken);
            setUser(validatedUser);
            await saveUser(validatedUser);
            // Refresh token to extend expiry (best-effort, don't block)
            refreshToken(storedToken).catch(() => {});
            // Use surveyCompleted from user record (set during validate)
            if (validatedUser.surveyCompleted) {
              setSurveyCompleted(true);
            } else {
              // Fallback: check survey table
              try {
                const survey = await getSurveyStatus(storedToken);
                setSurveyCompleted(survey.completed);
              } catch {
                setSurveyCompleted(false);
              }
            }
          } else {
            // Session expired or account deleted — clear local state
            await clearToken();
          }
        }
      } catch {
        // Silently fail; user stays unauthenticated.
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  // Refresh token when app comes to foreground (extends expiry)
  useEffect(() => {
    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState === "active" && token) {
        refreshToken(token).then((ok) => {
          if (!ok) {
            // Token expired while app was in background — force logout
            console.log("[auth] Token expired — logging out");
            clearToken().then(() => {
              setToken(null);
              setUser(null);
              setSurveyCompleted(false);
            });
          }
        }).catch(() => {});
      }
    };
    const sub = AppState.addEventListener("change", handleAppState);
    return () => sub.remove();
  }, [token]);

  const login = useCallback(async (newToken: string) => {
    const validatedUser = await validateToken(newToken);
    if (!validatedUser) {
      throw new Error("Invalid token");
    }
    await saveToken(newToken);
    await saveUser(validatedUser);
    setToken(newToken);
    setUser(validatedUser);
    // Use surveyCompleted from user record if available
    if (validatedUser.surveyCompleted) {
      setSurveyCompleted(true);
    } else {
      try {
        const survey = await getSurveyStatus(newToken);
        setSurveyCompleted(survey.completed);
      } catch {
        setSurveyCompleted(false);
      }
    }
  }, []);

  const logout = useCallback(async () => {
    // Best-effort: invalidate all sessions server-side before clearing locally
    if (token) {
      fetch(`${getConvexSiteUrl()}/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    await clearToken();
    await clearCache(); // Clear cached tasks from previous session
    setToken(null);
    setUser(null);
    setSurveyCompleted(false);
  }, [token]);

  const markSurveyCompleted = useCallback(() => {
    setSurveyCompleted(true);
  }, []);

  const refreshUser = useCallback(async () => {
    if (!token) return;
    const validatedUser = await validateToken(token);
    if (validatedUser) {
      setUser(validatedUser);
      await saveUser(validatedUser);
    }
  }, [token]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      token,
      isLoading,
      isAuthenticated: !!token && !!user,
      surveyCompleted,
      login,
      logout,
      markSurveyCompleted,
      refreshUser,
    }),
    [user, token, isLoading, surveyCompleted, login, logout, markSurveyCompleted, refreshUser]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
