import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  User,
  getToken,
  getUser,
  saveToken,
  saveUser,
  clearToken,
  validateToken,
  getSurveyStatus,
} from "../lib/auth";

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  surveyCompleted: boolean;
  login: (token: string) => Promise<void>;
  logout: () => Promise<void>;
  markSurveyCompleted: () => void;
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
        const storedToken = await getToken();
        if (storedToken) {
          const storedUser = await getUser();
          if (storedUser) {
            setToken(storedToken);
            setUser(storedUser);
          } else {
            // Token exists but no cached user — validate remotely
            const validatedUser = await validateToken(storedToken);
            if (validatedUser) {
              setToken(storedToken);
              setUser(validatedUser);
              await saveUser(validatedUser);
            } else {
              await clearToken();
            }
          }
          // Check survey status
          try {
            const survey = await getSurveyStatus(storedToken);
            setSurveyCompleted(survey.completed);
          } catch {
            setSurveyCompleted(false);
          }
        }
      } catch {
        // Silently fail; user stays unauthenticated.
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const login = useCallback(async (newToken: string) => {
    const validatedUser = await validateToken(newToken);
    if (!validatedUser) {
      throw new Error("Invalid token");
    }
    await saveToken(newToken);
    await saveUser(validatedUser);
    setToken(newToken);
    setUser(validatedUser);
    // Check survey status after login
    try {
      const survey = await getSurveyStatus(newToken);
      setSurveyCompleted(survey.completed);
    } catch {
      setSurveyCompleted(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await clearToken();
    setToken(null);
    setUser(null);
    setSurveyCompleted(false);
  }, []);

  const markSurveyCompleted = useCallback(() => {
    setSurveyCompleted(true);
  }, []);

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
    }),
    [user, token, isLoading, surveyCompleted, login, logout, markSurveyCompleted]
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
